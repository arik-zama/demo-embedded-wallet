"use client"

import { useMemo, useState, useEffect } from "react"
import Script from "next/script"
import { useWallets } from "@/providers/wallet-provider"
import { useTurnkey } from "@turnkey/react-wallet-kit"
import { formatEther } from "viem"

import { truncateAddress } from "@/lib/utils"
import { useTokenPrice } from "@/hooks/use-token-price"
import { getTurnkeyWalletClient, getPublicClient } from "@/lib/web3"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Loader2, Eye, Lock } from "lucide-react"

import { Icons } from "./icons"

// ERC-7984 Confidential Token on Sepolia (cUSDT)
const CONFIDENTIAL_TOKEN_ADDRESS = "0xb6f50111A608b035c385c3FA79de77D8e3fef056" as const
const CONFIDENTIAL_TOKEN_SYMBOL = "cUSDT"
const CONFIDENTIAL_TOKEN_DECIMALS = 6

// ERC-7984 ABI
const ERC7984_ABI = [
  {
    name: "confidentialBalanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

export default function Assets() {
  const { state } = useWallets()
  const { ethPrice } = useTokenPrice()
  const { selectedAccount } = state
  const { httpClient, session } = useTurnkey()

  // Confidential token state
  const [scriptLoaded, setScriptLoaded] = useState(false)
  const [sdkInstance, setSdkInstance] = useState<any>(null)
  const [encryptedHandle, setEncryptedHandle] = useState<bigint | null>(null)
  const [revealedBalance, setRevealedBalance] = useState<string | null>(null)
  const [isRevealing, setIsRevealing] = useState(false)
  const [revealError, setRevealError] = useState<string | null>(null)

  // Initialize SDK
  useEffect(() => {
    const existingSdk = (window as any).relayerSDK
    if (existingSdk && !scriptLoaded) {
      setScriptLoaded(true)
    }
    if (!scriptLoaded) return

    const initSdk = async () => {
      if (sdkInstance) return
      try {
        const sdk = (window as any).relayerSDK
        if (!sdk) return
        await sdk.initSDK()
        const instance = await sdk.createInstance(sdk.SepoliaConfig)
        setSdkInstance(instance)
      } catch (err) {
        console.error("[SDK] Init failed:", err)
      }
    }
    initSdk()
  }, [scriptLoaded, sdkInstance])

  // Fetch encrypted balance handle on mount
  useEffect(() => {
    if (!selectedAccount?.address) return
    const fetchHandle = async () => {
      try {
        const publicClient = getPublicClient()
        const handle = await publicClient.readContract({
          address: CONFIDENTIAL_TOKEN_ADDRESS,
          abi: ERC7984_ABI,
          functionName: "confidentialBalanceOf",
          args: [selectedAccount.address as `0x${string}`],
        })
        console.log("[Assets] Encrypted handle from contract:", handle.toString(), "hex:", "0x" + handle.toString(16))
        setEncryptedHandle(handle)
      } catch (err) {
        console.error("[Assets] Failed to fetch encrypted handle:", err)
        setEncryptedHandle(null)
      }
    }
    fetchHandle()
  }, [selectedAccount?.address])

  // Reveal confidential balance
  const handleReveal = async () => {
    if (!selectedAccount || !httpClient || !sdkInstance || encryptedHandle === null) return
    setIsRevealing(true)
    setRevealError(null)

    try {
      const walletClient = await getTurnkeyWalletClient(
        httpClient as any,
        selectedAccount.address,
        session?.organizationId
      )

      const keypair = sdkInstance.generateKeypair()
      const contractAddresses = [CONFIDENTIAL_TOKEN_ADDRESS]
      const timestamp = Math.floor(Date.now() / 1000)
      const duration = 1

      const eip712 = sdkInstance.createEIP712(
        keypair.publicKey,
        contractAddresses,
        timestamp,
        duration
      )

      const signature = await walletClient.signTypedData({
        domain: eip712.domain,
        types: { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
        primaryType: "UserDecryptRequestVerification",
        message: eip712.message,
      })

      console.log("[Reveal] Signature obtained:", signature.slice(0, 20) + "...")

      // If handle is 0, balance is 0 (signature proves authorization, no decrypt needed)
      if (encryptedHandle === 0n) {
        console.log("[Reveal] Balance handle is 0, showing zero balance")
        setRevealedBalance("0")
        return
      }

      // Prepare handle for userDecrypt (non-zero balance)
      const handleHex = "0x" + encryptedHandle.toString(16).padStart(64, "0")
      const handles = [{ handle: handleHex, contractAddress: CONFIDENTIAL_TOKEN_ADDRESS }]

      console.log("[Reveal] Calling userDecrypt for handle:", handleHex.slice(0, 20) + "...")
      const decrypted = await sdkInstance.userDecrypt(
        handles,
        keypair.privateKey,
        keypair.publicKey,
        signature,
        contractAddresses,
        selectedAccount.address,
        timestamp,
        duration
      )

      console.log("[Reveal] Decrypted result:", decrypted)
      // Response is { [handleHex]: decryptedValue } - extract the first value
      const values = Object.values(decrypted || {})
      const value = values[0]
      if (value !== undefined && value !== null) {
        const formatted = (Number(value) / Math.pow(10, CONFIDENTIAL_TOKEN_DECIMALS)).toFixed(2)
        console.log("[Reveal] Formatted balance:", formatted)
        setRevealedBalance(formatted)
      } else {
        setRevealedBalance("0")
      }
    } catch (err) {
      console.error("[Reveal] Failed:", err)
      setRevealError(err instanceof Error ? err.message : "Reveal failed")
    } finally {
      setIsRevealing(false)
    }
  }

  // Memoize the balance calculation
  const amount = useMemo(() => {
    return selectedAccount?.balance
      ? parseFloat(
          Number(formatEther(selectedAccount?.balance ?? BigInt(0))).toFixed(8)
        ).toString()
      : "0"
  }, [selectedAccount?.balance])

  // Memoize the value calculation
  const valueInUSD = useMemo(() => {
    return (
      Number(formatEther(selectedAccount?.balance ?? BigInt(0))) *
      (ethPrice || 0)
    ).toFixed(2)
  }, [selectedAccount?.balance, ethPrice])

  return (
    <>
      {/* Load Relayer SDK for confidential tokens */}
      <Script
        src="/fhevm/relayer-sdk-js.umd.cjs"
        strategy="afterInteractive"
        onLoad={() => setScriptLoaded(true)}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg sm:text-2xl">Assets</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="">
                <TableHead>Asset</TableHead>
                <TableHead className="hidden sm:table-cell">Address</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead className="hidden sm:table-cell">
                  Value (USD)
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* ETH Row */}
              <TableRow>
                <TableCell className="p-2 font-medium sm:p-4">
                  <div className="flex items-center space-x-2 text-xs sm:text-sm">
                    <Icons.ethereum className="h-6 w-6" />
                    <span>Ethereum (Sepolia)</span>
                  </div>
                </TableCell>
                <TableCell className="hidden font-mono text-xs sm:table-cell">
                  {selectedAccount?.address &&
                    truncateAddress(selectedAccount?.address)}
                </TableCell>
                <TableCell className="hidden sm:table-cell">{amount}</TableCell>
                <TableCell className="hidden sm:table-cell">
                  ${valueInUSD}
                </TableCell>
                <TableCell className="p-2 sm:hidden">
                  <div className="font-medium">
                    {amount}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ETH
                    </span>
                  </div>
                  <div className=" text-sm text-muted-foreground">
                    ${valueInUSD}
                  </div>
                </TableCell>
              </TableRow>

              {/* Confidential Token Row (ERC-7984) */}
              {encryptedHandle !== null && (
                <TableRow>
                  <TableCell className="p-2 font-medium sm:p-4">
                    <div className="flex items-center space-x-2 text-xs sm:text-sm">
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900">
                        <Lock className="h-3 w-3 text-purple-600 dark:text-purple-400" />
                      </div>
                      <span>{CONFIDENTIAL_TOKEN_SYMBOL}</span>
                      <span className="text-xs text-muted-foreground">(Confidential)</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs sm:table-cell">
                    {truncateAddress(CONFIDENTIAL_TOKEN_ADDRESS)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {revealedBalance !== null ? (
                      <span>{revealedBalance}</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleReveal}
                        disabled={isRevealing || !sdkInstance}
                        className="h-7 px-2 text-xs"
                      >
                        {isRevealing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <Eye className="mr-1 h-3 w-3" />
                            Reveal
                          </>
                        )}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {revealedBalance !== null ? (
                      <span className="text-muted-foreground">-</span>
                    ) : (
                      <span className="text-muted-foreground">Encrypted</span>
                    )}
                  </TableCell>
                  {/* Mobile view */}
                  <TableCell className="p-2 sm:hidden">
                    {revealedBalance !== null ? (
                      <div className="font-medium">
                        {revealedBalance}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {CONFIDENTIAL_TOKEN_SYMBOL}
                        </span>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleReveal}
                        disabled={isRevealing || !sdkInstance}
                        className="h-7 px-2 text-xs"
                      >
                        {isRevealing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <Eye className="mr-1 h-3 w-3" />
                            Reveal
                          </>
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {revealError && (
            <p className="mt-2 text-xs text-red-500">{revealError}</p>
          )}
        </CardContent>
      </Card>
    </>
  )
}
