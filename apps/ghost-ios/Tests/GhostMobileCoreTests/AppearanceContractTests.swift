import Foundation
import Testing
@testable import GhostMobileCore

@Suite struct AppearanceContractTests {
    @Test func optionalAppearanceDecoding() throws {
        let decoder = JSONDecoder()
        let present = try decoder.decode(Look.self, from: Data(##"{"face":"arcs","mark":"sprout","body":"#3d5cf5"}"##.utf8))
        #expect(present.face == .arcs)
        #expect(present.mark == .sprout)
        #expect(present.body == "#3d5cf5")
        let absent = try decoder.decode(Look.self, from: Data("{}".utf8))
        #expect(absent.face == nil)
        #expect(absent.mark == nil)
        let unknown = try decoder.decode(Look.self, from: Data(#"{"face":"future-face","mark":"future-mark"}"#.utf8))
        #expect(unknown.face == nil)
        #expect(unknown.mark == nil)
        let mixed = try decoder.decode(Look.self, from: Data(#"{"face":"dots","mark":"future-mark"}"#.utf8))
        #expect(mixed.face == .dots)
        #expect(mixed.mark == nil)
        #expect(try decoder.decode(Look.self, from: JSONEncoder().encode(present)) == present)
        for face in LookFace.allCases {
            #expect(try decoder.decode(Look.self, from: Data("{\"face\":\"\(face.rawValue)\"}".utf8)).face == face)
        }
        for mark in LookMark.allCases {
            #expect(try decoder.decode(Look.self, from: Data("{\"mark\":\"\(mark.rawValue)\"}".utf8)).mark == mark)
        }
    }

    @Test func optionalReasoningDecoding() throws {
        let decoder = JSONDecoder()
        let message = Message(id: "m", conversationId: "c", role: .assistant, origin: nil, text: "답변", createdAt: 1)
        var object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any])
        #expect(try decoder.decode(Message.self, from: JSONSerialization.data(withJSONObject: object)).thinking == nil)
        object["thinking"] = "첫 단계\n다음 단계"
        let withThinking = try decoder.decode(Message.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(withThinking.thinking == "첫 단계\n다음 단계")
        #expect(try decoder.decode(Message.self, from: JSONEncoder().encode(withThinking)) == withThinking)
        let absent = try decoder.decode(Live.self, from: Data(#"{"conversationId":"c","running":true,"tools":[]}"#.utf8))
        #expect(absent.thinking == nil)
        let present = try decoder.decode(Live.self, from: Data(#"{"conversationId":"c","running":true,"thinking":"생각 중","tools":[]}"#.utf8))
        #expect(present.thinking == "생각 중")
        #expect(try decoder.decode(Live.self, from: JSONEncoder().encode(present)) == present)
        let nulls = try decoder.decode(Look.self, from: Data(#"{"face":null,"mark":null}"#.utf8))
        #expect(nulls.face == nil && nulls.mark == nil)
    }

    @Test func defaultHueUsesWrappingUTF16Hash() {
        #expect(GhostAppearance.defaultBodyColor(id: "") == "#3d5cf5")
        #expect(GhostAppearance.defaultBodyColor(id: "ghost-fixture") == "#ff8a1f")
        #expect(GhostAppearance.defaultBodyColor(id: "Ghost") == "#ef4b3f")
        #expect(GhostAppearance.defaultBodyColor(id: "고스트") == "#f25ca2")
        #expect(GhostAppearance.defaultBodyColor(id: "👻") == "#2f9bff")
        #expect(GhostAppearance.defaultBodyColor(id: String(repeating: "a", count: 100)) == "#3d5cf5")
    }
}
