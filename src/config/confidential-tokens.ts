// ERC-7984 Confidential Token on Sepolia (cUSDT)
export const CONFIDENTIAL_TOKEN_ADDRESS =
  "0xb6f50111A608b035c385c3FA79de77D8e3fef056" as const

export const CONFIDENTIAL_TOKEN_SYMBOL = "cUSDT"
export const CONFIDENTIAL_TOKEN_DECIMALS = 6

// ConfidentialTransfer event signature
// Event: ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)
export const CONFIDENTIAL_TRANSFER_EVENT_SIGNATURE =
  "0x67500e8d0ed826d2194f514dd0d8124f35648ab6e3fb5e6ed867134cffe661e9"

export const ERC7984_ABI = [
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
