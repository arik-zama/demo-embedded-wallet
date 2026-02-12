import {
  CONFIDENTIAL_TOKEN_ADDRESS,
  CONFIDENTIAL_TOKEN_DECIMALS,
} from "@/config/confidential-tokens"

type HandleInput = {
  handle: string
  contractAddress: string
}

// WalletClient with a bound account (from getTurnkeyWalletClient)
type SigningWalletClient = {
  signTypedData: (args: any) => Promise<string>
}

/**
 * Low-level decrypt: generates keypair, creates EIP-712, signs, calls userDecrypt.
 * Returns the raw result map from the SDK: { [handleHex]: decryptedValue }
 */
export async function decryptHandles(
  sdkInstance: any,
  walletClient: SigningWalletClient,
  signerAddress: string,
  handles: HandleInput[]
): Promise<Record<string, bigint | number>> {
  const contractAddresses = [
    ...new Set(handles.map((h) => h.contractAddress)),
  ]
  const keypair = sdkInstance.generateKeypair()
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
    types: {
      UserDecryptRequestVerification:
        eip712.types.UserDecryptRequestVerification,
    },
    primaryType: "UserDecryptRequestVerification",
    message: eip712.message,
  })

  const decrypted = await sdkInstance.userDecrypt(
    handles,
    keypair.privateKey,
    keypair.publicKey,
    signature,
    contractAddresses,
    signerAddress,
    timestamp,
    duration
  )

  return decrypted || {}
}

/**
 * Convenience wrapper: decrypts a single handle and returns a formatted decimal string.
 * Returns "0" for zero handles, null if decryption yields nothing.
 */
export async function decryptAndFormat(
  sdkInstance: any,
  walletClient: SigningWalletClient,
  signerAddress: string,
  handle: bigint,
  contractAddress: string = CONFIDENTIAL_TOKEN_ADDRESS,
  decimals: number = CONFIDENTIAL_TOKEN_DECIMALS
): Promise<string | null> {
  if (handle === 0n) {
    return "0"
  }

  const handleHex =
    "0x" + handle.toString(16).padStart(64, "0")
  const handles = [{ handle: handleHex, contractAddress }]

  const decrypted = await decryptHandles(
    sdkInstance,
    walletClient,
    signerAddress,
    handles
  )

  const values = Object.values(decrypted)
  const value = values[0]

  if (value !== undefined && value !== null) {
    return (Number(value) / Math.pow(10, decimals)).toFixed(2)
  }

  return null
}
