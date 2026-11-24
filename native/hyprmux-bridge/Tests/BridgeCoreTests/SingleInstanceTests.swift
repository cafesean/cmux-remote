import XCTest
@testable import BridgeCore

/// k126: one HyprMux Bridge menu app per Mac.
final class SingleInstanceTests: XCTestCase {
  private let me = SingleInstance.Peer(pid: 300, launched: 1_000)

  func testAloneKeepsSelf() {
    XCTAssertEqual(SingleInstance.decide(selfPeer: me, others: []), .keepSelf(quit: []))
  }

  func testNewestLaunchWinsAndOlderOnesQuit() {
    let old1 = SingleInstance.Peer(pid: 100, launched: 900), old2 = SingleInstance.Peer(pid: 200, launched: 950)
    XCTAssertEqual(SingleInstance.decide(selfPeer: me, others: [old1, old2]), .keepSelf(quit: [100, 200]))
  }

  func testOlderSelfQuitsForTheNewerOne() {
    let newer = SingleInstance.Peer(pid: 50, launched: 1_200)
    XCTAssertEqual(SingleInstance.decide(selfPeer: me, others: [newer]), .quitSelf(winner: 50))
  }

  func testEveryInstanceAgreesOnOneWinner() {
    // The mini case (m 3660): two menu apps started 29 s apart, plus a third launch now.
    let a = SingleInstance.Peer(pid: 31554, launched: 1_000), b = SingleInstance.Peer(pid: 34626, launched: 1_029)
    let c = SingleInstance.Peer(pid: 40000, launched: 5_000)
    let all = [a, b, c]
    let keepers = all.filter { p in
      if case .keepSelf = SingleInstance.decide(selfPeer: p, others: all.filter { $0 != p }) { return true }
      return false
    }
    XCTAssertEqual(keepers.map(\.pid), [40000])
  }

  func testSameLaunchSecondGoesToHigherPidAndUnknownTimeSortsOldest() {
    let twin = SingleInstance.Peer(pid: 301, launched: 1_000)
    XCTAssertEqual(SingleInstance.decide(selfPeer: me, others: [twin]), .quitSelf(winner: 301))
    let unknown = SingleInstance.Peer(pid: 999, launched: nil)
    XCTAssertEqual(SingleInstance.decide(selfPeer: me, others: [unknown]), .keepSelf(quit: [999]))
  }

  func testSelfInOthersIsIgnored() {
    XCTAssertEqual(SingleInstance.decide(selfPeer: me, others: [me]), .keepSelf(quit: []))
  }
}
