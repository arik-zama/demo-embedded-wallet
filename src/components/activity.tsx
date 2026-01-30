"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import Script from "next/script"
import { useTransactions } from "@/providers/transactions-provider"
import { useWallets } from "@/providers/wallet-provider"
import { useTurnkey } from "@turnkey/react-wallet-kit"
import { ArrowDownIcon, ArrowUpIcon, LoaderIcon, Lock, Eye, Loader2 } from "lucide-react"
import { formatEther } from "viem"

import type { Transaction } from "@/types/web3"
import { getPublicClient, getTurnkeyWalletClient } from "@/lib/web3"
import { useTokenPrice } from "@/hooks/use-token-price"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { ScrollArea } from "./ui/scroll-area"

// Confidential token contract address (cUSDT on Sepolia)
const CONFIDENTIAL_TOKEN_ADDRESS = "0xb6f50111A608b035c385c3FA79de77D8e3fef056"
const CONFIDENTIAL_TOKEN_DECIMALS = 6

// Transfer event signature for parsing logs
const TRANSFER_EVENT_SIGNATURE = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

export default function Activity() {
  const { transactions: allTransactions, loading } = useTransactions()
  const { ethPrice } = useTokenPrice()
  const { state } = useWallets()
  const { selectedAccount } = state
  const { httpClient, session } = useTurnkey()

  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [scriptLoaded, setScriptLoaded] = useState(false)
  const [sdkInstance, setSdkInstance] = useState<any>(null)
  const [revealedAmounts, setRevealedAmounts] = useState<Record<string, string>>({})
  const [revealingTx, setRevealingTx] = useState<string | null>(null)

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
        console.error("[Activity SDK] Init failed:", err)
      }
    }
    initSdk()
  }, [scriptLoaded, sdkInstance])

  useEffect(() => {
    const fetchTransactions = async () => {
      if (
        selectedAccount?.address &&
        allTransactions[selectedAccount.address]
      ) {
        setTransactions(allTransactions[selectedAccount.address])
      }
    }
    fetchTransactions()
  }, [allTransactions, selectedAccount])

  // Reset revealed amounts when wallet changes
  useEffect(() => {
    setRevealedAmounts({})
  }, [selectedAccount?.address])

  // Reveal confidential transfer amount
  const handleRevealAmount = async (txHash: string) => {
    if (!selectedAccount || !httpClient || !sdkInstance) return

    setRevealingTx(txHash)
    try {
      const publicClient = getPublicClient()

      // Fetch transaction receipt to get logs
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` })

      // Find Transfer event from cUSDT contract
      const transferLog = receipt.logs.find(
        log =>
          log.address.toLowerCase() === CONFIDENTIAL_TOKEN_ADDRESS.toLowerCase() &&
          log.topics[0] === TRANSFER_EVENT_SIGNATURE
      )

      if (!transferLog || !transferLog.data) {
        console.log("[Activity] No Transfer event found in tx")
        setRevealedAmounts(prev => ({ ...prev, [txHash]: "N/A" }))
        return
      }

      // The data field contains the encrypted amount handle
      // For ERC-7984, this is typically an encrypted handle (euint64)
      const encryptedHandle = BigInt(transferLog.data)

      if (encryptedHandle === 0n) {
        setRevealedAmounts(prev => ({ ...prev, [txHash]: "0" }))
        return
      }

      console.log("[Activity] Decrypting handle:", encryptedHandle.toString())

      // Get wallet client for signing
      const walletClient = await getTurnkeyWalletClient(
        httpClient as any,
        selectedAccount.address,
        session?.organizationId
      )

      // Generate keypair and create EIP-712 for decryption
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

      // Prepare handle for userDecrypt
      const handleHex = "0x" + encryptedHandle.toString(16).padStart(64, "0")
      const handles = [{ handle: handleHex, contractAddress: CONFIDENTIAL_TOKEN_ADDRESS }]

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

      const values = Object.values(decrypted || {})
      const value = values[0]

      if (value !== undefined && value !== null) {
        const formatted = (Number(value) / Math.pow(10, CONFIDENTIAL_TOKEN_DECIMALS)).toFixed(2)
        setRevealedAmounts(prev => ({ ...prev, [txHash]: formatted }))
      } else {
        setRevealedAmounts(prev => ({ ...prev, [txHash]: "0" }))
      }
    } catch (err) {
      console.error("[Activity] Reveal failed:", err)
      setRevealedAmounts(prev => ({ ...prev, [txHash]: "Error" }))
    } finally {
      setRevealingTx(null)
    }
  }

  return (
    <>
      {/* Load Relayer SDK for confidential token decryption */}
      <Script
        src="/fhevm/relayer-sdk-js.umd.cjs"
        strategy="afterInteractive"
        onLoad={() => setScriptLoaded(true)}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg sm:text-2xl">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="flex max-h-[450px] w-full flex-col overflow-y-auto rounded-md">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Date</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead className="hidden sm:table-cell">To</TableHead>
                  <TableHead>Amount</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                  </TableRow>
                ) : transactions.length > 0 ? (
                  transactions.map((transaction) => (
                    <TableRow key={transaction.hash}>
                      <TableCell>
                        <Link
                          href={`https://sepolia.etherscan.io/tx/${transaction.hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 capitalize"
                        >
                          {transaction.status === "received" ? (
                            <ArrowDownIcon className="h-4 w-4 text-green-500" />
                          ) : transaction.status === "pending" ? (
                            <LoaderIcon className="h-4 w-4 animate-spin text-yellow-500" />
                          ) : (
                            <ArrowUpIcon className="h-4 w-4 text-red-500" />
                          )}
                          {transaction.status}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden p-1 text-xs sm:table-cell md:p-4 md:text-sm">
                        {new Date(transaction.timestamp).toLocaleString("en-US", {
                          month: "long",
                          day: "2-digit",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs sm:table-cell">
                        <Link
                          className="underline underline-offset-4"
                          href={`https://sepolia.etherscan.io/address/${transaction.from}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {transaction.from.slice(0, 6)}...
                          {transaction.from.slice(-4)}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <Link
                          className="underline underline-offset-4"
                          href={`https://sepolia.etherscan.io/address/${transaction.to}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {transaction?.to?.slice(0, 6)}...
                          {transaction?.to?.slice(-4)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {transaction.to?.toLowerCase() === CONFIDENTIAL_TOKEN_ADDRESS.toLowerCase() ? (
                          // Confidential token transaction
                          <div className="flex items-center gap-1">
                            <Lock className="h-3 w-3 text-purple-500" />
                            {revealedAmounts[transaction.hash] ? (
                              <span className="font-medium text-purple-600 dark:text-purple-400">
                                {revealedAmounts[transaction.hash]} cUSDT
                              </span>
                            ) : (
                              <>
                                <span className="font-medium text-purple-600 dark:text-purple-400">
                                  cUSDT
                                </span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleRevealAmount(transaction.hash)}
                                  disabled={revealingTx === transaction.hash || !sdkInstance}
                                  className="h-5 px-1 text-xs"
                                >
                                  {revealingTx === transaction.hash ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Eye className="h-3 w-3" />
                                  )}
                                </Button>
                              </>
                            )}
                          </div>
                        ) : (
                          // Regular ETH transaction
                          <>
                            <div className="font-medium">
                              {transaction.value ? formatEther(transaction.value) : 0}{" "}
                              <span className="text-xs text-muted-foreground">
                                ETH
                              </span>
                            </div>
                            <div className="text-sm text-muted-foreground">
                              $
                              {transaction.value
                                ? (
                                    parseFloat(formatEther(transaction.value)) *
                                    (ethPrice ?? 0)
                                  ).toFixed(2)
                                : 0}
                            </div>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      className="text-center text-muted-foreground"
                      colSpan={5}
                    >
                      No activity. Send or receive tokens to see transactions here.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </>
  )
}
