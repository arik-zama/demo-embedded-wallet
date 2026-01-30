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
import { Loader2, Eye, Lock, Send } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

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
  {
    name: "confidentialTransfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "encryptedAmount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
    ],
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

  // Transfer state
  const [sendDialogOpen, setSendDialogOpen] = useState(false)
  const [sendRecipient, setSendRecipient] = useState("")
  const [sendAmount, setSendAmount] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendSuccess, setSendSuccess] = useState<string | null>(null)
  const [sendTxHash, setSendTxHash] = useState<string | null>(null)

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

  // Reset state when wallet changes
  useEffect(() => {
    setRevealedBalance(null)
    setEncryptedHandle(null)
    setRevealError(null)
    setSendError(null)
    setSendSuccess(null)
    setSendTxHash(null)
  }, [selectedAccount?.address])

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

  // Send confidential tokens
  const handleSend = async () => {
    if (!selectedAccount || !httpClient || !sdkInstance) return
    if (!sendRecipient || !sendAmount) return

    setIsSending(true)
    setSendError(null)
    setSendSuccess(null)
    setSendTxHash(null)

    try {
      // Parse amount to raw units (6 decimals)
      const rawAmount = BigInt(Math.floor(parseFloat(sendAmount) * Math.pow(10, CONFIDENTIAL_TOKEN_DECIMALS)))
      const requestedAmount = parseFloat(sendAmount)

      // Log balance info for debugging but allow transfer regardless
      if (revealedBalance !== null) {
        const balance = parseFloat(revealedBalance)
        if (balance < requestedAmount) {
          console.log("[Send] Warning: Requested amount exceeds revealed balance. ERC-7984 may transfer 0 or revert.")
        }
      }

      console.log("[Send] Creating encrypted input for amount:", rawAmount.toString())

      // Store the balance handle before transfer for post-validation
      const balanceHandleBefore = encryptedHandle

      // Create encrypted input
      const encryptedInput = sdkInstance.createEncryptedInput(
        CONFIDENTIAL_TOKEN_ADDRESS,
        selectedAccount.address
      )
      encryptedInput.add64(rawAmount)
      const { handles, inputProof } = await encryptedInput.encrypt()

      // Convert Uint8Array to hex strings for viem
      const handleHex = "0x" + Array.from(handles[0] as Uint8Array).map(b => b.toString(16).padStart(2, "0")).join("") as `0x${string}`
      const proofHex = "0x" + Array.from(inputProof as Uint8Array).map(b => b.toString(16).padStart(2, "0")).join("") as `0x${string}`

      console.log("[Send] Encrypted handle:", handleHex.slice(0, 20) + "...")
      console.log("[Send] Input proof length:", proofHex.length)

      // Get wallet client for signing transaction
      const walletClient = await getTurnkeyWalletClient(
        httpClient as any,
        selectedAccount.address,
        session?.organizationId
      )

      // Send the confidential transfer transaction
      console.log("[Send] Sending confidentialTransfer to:", sendRecipient)
      const hash = await walletClient.writeContract({
        address: CONFIDENTIAL_TOKEN_ADDRESS,
        abi: ERC7984_ABI,
        functionName: "confidentialTransfer",
        args: [sendRecipient as `0x${string}`, handleHex, proofHex],
      })

      console.log("[Send] Transaction hash:", hash)
      setSendSuccess(`Waiting for confirmation...`)

      // Wait for transaction confirmation
      const publicClient = getPublicClient()
      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === "success") {
        console.log("[Send] Transaction confirmed:", receipt)

        // Post-validation: Re-fetch balance handle to verify transfer happened
        const newHandle = await publicClient.readContract({
          address: CONFIDENTIAL_TOKEN_ADDRESS,
          abi: ERC7984_ABI,
          functionName: "confidentialBalanceOf",
          args: [selectedAccount.address as `0x${string}`],
        })

        console.log("[Send] Balance handle before:", balanceHandleBefore?.toString())
        console.log("[Send] Balance handle after:", newHandle.toString())

        // If balance handle didn't change, transfer likely sent 0
        if (balanceHandleBefore !== null && newHandle === balanceHandleBefore) {
          console.log("[Send] WARNING: Balance handle unchanged - transfer likely sent 0")
          setSendError("Transfer completed but your balance didn't change. This may indicate the transfer sent 0 tokens due to insufficient balance.")
          setSendSuccess(null)
          setSendTxHash(hash)
        } else {
          setSendSuccess("Transfer confirmed!")
          setSendTxHash(hash)
          // Reset form only on verified success
          setSendRecipient("")
          setSendAmount("")
        }

        // Update the handle and reset revealed balance to force re-reveal
        setEncryptedHandle(newHandle)
        setRevealedBalance(null)
      } else {
        console.log("[Send] Transaction reverted:", receipt)
        setSendError("Transaction reverted on-chain")
        setSendSuccess(null)
      }

    } catch (err) {
      console.error("[Send] Failed:", err)
      const errorMessage = err instanceof Error ? err.message : "Transfer failed"
      // Check for common errors
      if (errorMessage.includes("gas required exceeds allowance") || errorMessage.includes("insufficient funds")) {
        setSendError("Insufficient ETH for gas fees. Please add funds to your wallet first.")
      } else {
        setSendError(errorMessage)
      }
    } finally {
      setIsSending(false)
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
                      <div className="flex items-center gap-2">
                        <span>{revealedBalance}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSendDialogOpen(true)}
                          className="h-6 px-2 text-xs"
                        >
                          <Send className="h-3 w-3" />
                        </Button>
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
                      <div className="flex items-center gap-2">
                        <div className="font-medium">
                          {revealedBalance}
                          <span className="ml-1 text-xs text-muted-foreground">
                            {CONFIDENTIAL_TOKEN_SYMBOL}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSendDialogOpen(true)}
                          className="h-6 px-2 text-xs"
                        >
                          <Send className="h-3 w-3" />
                        </Button>
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

      {/* Send Confidential Token Dialog */}
      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send {CONFIDENTIAL_TOKEN_SYMBOL}</DialogTitle>
            <DialogDescription>
              Transfer confidential tokens. The amount will be encrypted before sending.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="recipient">Recipient Address</Label>
              <Input
                id="recipient"
                placeholder="0x..."
                value={sendRecipient}
                onChange={(e) => setSendRecipient(e.target.value)}
                disabled={isSending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount">Amount ({CONFIDENTIAL_TOKEN_SYMBOL})</Label>
              <Input
                id="amount"
                type="number"
                placeholder="0.00"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                disabled={isSending}
              />
            </div>
            {revealedBalance === null && !sendError && !sendSuccess && (
              <div className="rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3">
                <p className="text-sm text-yellow-700 dark:text-yellow-400">
                  Balance not revealed. Consider revealing first to verify you have sufficient funds.
                </p>
              </div>
            )}
            {sendError && (
              <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3">
                <p className="text-sm text-red-700 dark:text-red-400">{sendError}</p>
                {sendTxHash && (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${sendTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-red-600 dark:text-red-300 underline mt-1 block"
                  >
                    View transaction on Etherscan
                  </a>
                )}
              </div>
            )}
            {sendSuccess && (
              <div className="rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3">
                <p className="text-sm text-green-700 dark:text-green-400">{sendSuccess}</p>
                {sendTxHash && (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${sendTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-green-600 dark:text-green-300 underline mt-1 block"
                  >
                    View transaction on Etherscan
                  </a>
                )}
              </div>
            )}
            <Button
              className="w-full"
              onClick={handleSend}
              disabled={isSending || !sendRecipient || !sendAmount || !sdkInstance}
            >
              {isSending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Encrypting & Sending...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Send {CONFIDENTIAL_TOKEN_SYMBOL}
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
