import Foundation

/// k123 (m 3237: a new Bridge copied over the old one kept the old services running until the menu app was
/// relaunched): the core agent compares the version of the bundle on DISK with the version it runs. A different
/// (or newer) copy on disk = the bundle was replaced; core exits, launchd (KeepAlive) starts the new core, and its
/// launch check (VersionGuard: version changed) restarts every agent from the new bundle.
public enum BundleSwap {
  /// The version in `<bundle>/Contents/Info.plist`, read from disk each call (never the cached Bundle), nil when unreadable.
  public static func onDiskVersion(bundlePath: String) -> String? {
    let url = URL(fileURLWithPath: bundlePath).appendingPathComponent("Contents/Info.plist")
    guard let data = try? Data(contentsOf: url),
          let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
          let v = plist["CFBundleShortVersionString"] as? String else { return nil }
    let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
  }

  /// True when the bundle on disk is another version than the one running. Unreadable = false (mid-copy: wait).
  public static func replaced(running: String, onDisk: String?) -> Bool {
    guard let d = onDisk else { return false }
    return d != running
  }
}
