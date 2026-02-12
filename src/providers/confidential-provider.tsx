"use client"

import React, { createContext, useContext, useEffect, useState } from "react"
import Script from "next/script"

type ConfidentialContextType = {
  sdkInstance: any
  sdkReady: boolean
}

const ConfidentialContext = createContext<ConfidentialContextType | undefined>(
  undefined
)

export const ConfidentialProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [scriptLoaded, setScriptLoaded] = useState(false)
  const [sdkInstance, setSdkInstance] = useState<any>(null)

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
        console.error("[ConfidentialProvider] SDK init failed:", err)
      }
    }
    initSdk()
  }, [scriptLoaded, sdkInstance])

  return (
    <ConfidentialContext.Provider
      value={{ sdkInstance, sdkReady: !!sdkInstance }}
    >
      <Script
        src="/fhevm/relayer-sdk-js.umd.cjs"
        strategy="afterInteractive"
        onLoad={() => setScriptLoaded(true)}
      />
      {children}
    </ConfidentialContext.Provider>
  )
}

export const useConfidential = () => {
  const context = useContext(ConfidentialContext)
  if (!context) {
    throw new Error(
      "useConfidential must be used within a ConfidentialProvider"
    )
  }
  return context
}
