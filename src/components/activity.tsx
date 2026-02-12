"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useTransactions } from "@/providers/transactions-provider"
import { useWallets } from "@/providers/wallet-provider"
import { useConfidential } from "@/providers/confidential-provider"
import { useTurnkey } from "@turnkey/react-wallet-kit"
import { ArrowDownIcon, ArrowUpIcon, LoaderIcon, Lock, Eye, Loader2 } from "lucide-react"
import { formatEther } from "viem"

import type { Transaction } from "@/types/web3"
import { getPublicClient, getTurnkeyWalletClient } from "@/lib/web3"
import { decryptAndFormat } from "@/lib/confidential"
import {
  CONFIDENTIAL_TOKEN_ADDRESS,
  CONFIDENTIAL_TRANSFER_EVENT_SIGNATURE,
} from "@/config/confidential-tokens"
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

export default function Activity() {
  const { transactions: allTransactions, loading } = useTransactions()
  const { ethPrice } = useTokenPrice()
  const { state } = useWallets()
  const { selectedAccount } = state
  const { httpClient, session } = useTurnkey()
  const { sdkInstance, sdkReady } = useConfidential()

  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [revealedAmounts, setRevealedAmounts] = useState<Record<string, string>>({})
  const [revealingTx, setRevealingTx] = useState<string | null>(null)

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

      // Find ConfidentialTransfer event from cUSDT contract
      const transferLog = receipt.logs.find(
        log =>
          log.address.toLowerCase() === CONFIDENTIAL_TOKEN_ADDRESS.toLowerCase() &&
          log.topics[0] === CONFIDENTIAL_TRANSFER_EVENT_SIGNATURE
      )

      if (!transferLog || !transferLog.topics[3]) {
        console.log("[Activity] No ConfidentialTransfer event found")
        setRevealedAmounts(prev => ({ ...prev, [txHash]: "N/A" }))
        return
      }

      // The amount handle is in topics[3] (indexed bytes32)
      const encryptedHandle = BigInt(transferLog.topics[3])
      console.log("[Activity] Found ConfidentialTransfer, amount handle:", transferLog.topics[3])

      const walletClient = await getTurnkeyWalletClient(
        httpClient as any,
        selectedAccount.address,
        session?.organizationId
      )

      const formatted = await decryptAndFormat(
        sdkInstance,
        walletClient,
        selectedAccount.address,
        encryptedHandle
      )

      setRevealedAmounts(prev => ({ ...prev, [txHash]: formatted ?? "0" }))
    } catch (err) {
      console.error("[Activity] Reveal failed:", err)
      setRevealedAmounts(prev => ({ ...prev, [txHash]: "Error" }))
    } finally {
      setRevealingTx(null)
    }
  }

  return (
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
                                disabled={revealingTx === transaction.hash || !sdkReady}
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
  )
}
