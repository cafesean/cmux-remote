// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "HyprMuxBridge",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "BridgeCore", targets: ["BridgeCore"]),
    .executable(name: "HyprMuxBridge", targets: ["HyprMuxBridge"]),
  ],
  targets: [
    .target(name: "BridgeCore"),
    .executableTarget(name: "HyprMuxBridge", dependencies: ["BridgeCore"]),
    .testTarget(name: "BridgeCoreTests", dependencies: ["BridgeCore"]),
  ]
)
