"use client"

import { useMemo, useState, useEffect } from "react"
import { useWallets } from "@/providers/wallet-provider"
import { useConfidential } from "@/providers/confidential-provider"
import { useTurnkey } from "@turnkey/react-wallet-kit"
import { formatEther } from "viem"

import { truncateAddress } from "@/lib/utils"
import { useTokenPrice } from "@/hooks/use-token-price"
import { getTurnkeyWalletClient, getPublicClient } from "@/lib/web3"
import { decryptAndFormat } from "@/lib/confidential"
import {
  CONFIDENTIAL_TOKEN_ADDRESS,
  CONFIDENTIAL_TOKEN_SYMBOL,
  CONFIDENTIAL_TOKEN_DECIMALS,
  ERC7984_ABI,
} from "@/config/confidential-tokens"
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

export default function Assets() {
  const { state } = useWallets()
  const { ethPrice } = useTokenPrice()
  const { selectedAccount } = state
  const { httpClient, session } = useTurnkey()
  const { sdkInstance, sdkReady } = useConfidential()

  // Confidential token state
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

      const formatted = await decryptAndFormat(
        sdkInstance,
        walletClient,
        selectedAccount.address,
        encryptedHandle
      )

      console.log("[Reveal] Formatted balance:", formatted)
      setRevealedBalance(formatted ?? "0")
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
        setSendTxHash(hash)

        // Post-validation: Decrypt new balance to verify actual transfer
        const newHandle = await publicClient.readContract({
          address: CONFIDENTIAL_TOKEN_ADDRESS,
          abi: ERC7984_ABI,
          functionName: "confidentialBalanceOf",
          args: [selectedAccount.address as `0x${string}`],
        })
        setEncryptedHandle(newHandle)

        // If we had a revealed balance before, decrypt new balance and compare
        const balanceBefore = revealedBalance !== null ? parseFloat(revealedBalance) : null

        if (balanceBefore !== null && newHandle !== 0n) {
          setSendSuccess("Verifying transfer...")
          try {
            const newBalanceStr = await decryptAndFormat(
              sdkInstance,
              walletClient,
              selectedAccount.address,
              newHandle
            )

            if (newBalanceStr !== null) {
              const newBalance = parseFloat(newBalanceStr)
              console.log("[Send] Balance before:", balanceBefore)
              console.log("[Send] Balance after:", newBalance)
              console.log("[Send] Requested amount:", requestedAmount)

              setRevealedBalance(newBalanceStr)

              const actualTransferred = balanceBefore - newBalance
              if (Math.abs(actualTransferred - requestedAmount) < 0.01) {
                setSendSuccess(`Transfer confirmed! Sent ${actualTransferred.toFixed(2)} ${CONFIDENTIAL_TOKEN_SYMBOL}`)
                setSendRecipient("")
                setSendAmount("")
              } else if (actualTransferred < 0.01) {
                setSendError(`Transfer failed: 0 tokens were actually transferred (insufficient balance). Your balance remains ${newBalance.toFixed(2)} ${CONFIDENTIAL_TOKEN_SYMBOL}.`)
                setSendSuccess(null)
              } else {
                setSendSuccess(`Transfer confirmed! Sent ${actualTransferred.toFixed(2)} ${CONFIDENTIAL_TOKEN_SYMBOL} (requested ${requestedAmount})`)
                setSendRecipient("")
                setSendAmount("")
              }
            } else {
              setSendSuccess("Transfer confirmed!")
              setRevealedBalance(null)
              setSendRecipient("")
              setSendAmount("")
            }
          } catch (decryptErr) {
            console.error("[Send] Post-transfer decrypt failed:", decryptErr)
            setSendSuccess("Transfer confirmed! (Could not verify amount)")
            setRevealedBalance(null)
            setSendRecipient("")
            setSendAmount("")
          }
        } else {
          setSendSuccess("Transfer confirmed!")
          setRevealedBalance(null)
          setSendRecipient("")
          setSendAmount("")
        }
      } else {
        console.log("[Send] Transaction reverted:", receipt)
        setSendError("Transaction reverted on-chain")
        setSendSuccess(null)
      }

    } catch (err) {
      console.error("[Send] Failed:", err)
      const errorMessage = err instanceof Error ? err.message : "Transfer failed"
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
                        disabled={isRevealing || !sdkReady}
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
                        disabled={isRevealing || !sdkReady}
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
              disabled={isSending || !sendRecipient || !sendAmount || !sdkReady}
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
