import Foundation
import CryptoKit
#if canImport(Security)
import Security
#endif

/// Generic-password store seam (login Keychain in the app, a dictionary in tests).
public protocol KeychainStore: AnyObject {
  func read(service: String, account: String) throws -> Data?
  func write(service: String, account: String, data: Data) throws
  func delete(service: String, account: String) throws
}

/// The Bridge's own per-install Ed25519 key. Lives only in the Keychain; any key file left by
/// another host in the state dir is never read or touched.
public final class InstallKeyStore {
  public static let service = BridgeAgent.bundleIdentifier
  public static let account = "install-key"
  let store: KeychainStore

  public init(store: KeychainStore) { self.store = store }

  public func loadOrCreate() throws -> Curve25519.Signing.PrivateKey {
    if let raw = try store.read(service: Self.service, account: Self.account), raw.count == 32 {
      return try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
    }
    let key = Curve25519.Signing.PrivateKey()
    try store.write(service: Self.service, account: Self.account, data: key.rawRepresentation)
    guard let back = try store.read(service: Self.service, account: Self.account), back == key.rawRepresentation else {
      throw BridgeError.io("install-key readback")
    }
    return key
  }
}

#if canImport(Security)
public final class LoginKeychain: KeychainStore {
  public init() {}

  private func base(_ service: String, _ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  public func read(service: String, account: String) throws -> Data? {
    var q = base(service, account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    if st == errSecItemNotFound { return nil }
    guard st == errSecSuccess else { throw BridgeError.io("keychain read \(st)") }
    return out as? Data
  }

  public func write(service: String, account: String, data: Data) throws {
    let q = base(service, account)
    let attrs: [String: Any] = [kSecValueData as String: data,
                                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    var st = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
    if st == errSecItemNotFound {
      var add = q
      add.merge(attrs) { $1 }
      st = SecItemAdd(add as CFDictionary, nil)
    }
    guard st == errSecSuccess else { throw BridgeError.io("keychain write \(st)") }
  }

  public func delete(service: String, account: String) throws {
    let st = SecItemDelete(base(service, account) as CFDictionary)
    guard st == errSecSuccess || st == errSecItemNotFound else { throw BridgeError.io("keychain delete \(st)") }
  }
}
#endif
