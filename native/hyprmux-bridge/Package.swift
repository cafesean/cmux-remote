// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "HyprMuxBridge",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "BridgeCore", targets: ["BridgeCore"]),
    .executable(name: "HyprMuxBridge", targets: ["HyprMuxBridge"]),
    .executable(name: "hm-screen-stream", targets: ["HMScreenStream"]),
  ],
  targets: [
    .target(name: "BridgeCore"),
    .executableTarget(name: "HyprMuxBridge", dependencies: ["BridgeCore"]),
    .testTarget(name: "BridgeCoreTests", dependencies: ["BridgeCore"]),
    // Screen capture + H.264 helper. Pure, testable logic lives in ScreenStreamCore.
    .target(name: "ScreenStreamCore"),
    .executableTarget(name: "HMScreenStream", dependencies: ["ScreenStreamCore"]),
    .testTarget(name: "ScreenStreamCoreTests", dependencies: ["ScreenStreamCore"]),
  ]
)
