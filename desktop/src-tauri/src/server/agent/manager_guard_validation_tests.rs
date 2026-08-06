//! `manager.rs` 的轮次守卫与请求校验测试。
//!
//! 经 `#[path]` 挂为 `manager` 的子模块；复用 `manager_tests` 的 entry 构造助手，保持
//! 主测试文件低于项目 1000 行上限，同时不改变原有测试语义。

use super::tests::test_entry;
use super::*;

// ── in-flight 轮次守卫(T4:防重叠 send_prompt)──

/// try_begin_turn:首次 true;未 end 时第二次 false;end 后再 true。
#[test]
fn try_begin_turn_gates_overlapping_turns() {
    let entry = test_entry();
    assert!(entry.try_begin_turn(), "首次开轮应成功");
    assert!(!entry.try_begin_turn(), "已有轮次进行中,第二次应被拒");
    entry.end_turn();
    assert!(entry.try_begin_turn(), "end_turn 后应可再次开轮");
    entry.end_turn();
}

/// begin_turn 的 RAII 守卫:持有期间再 begin 得 None;守卫 drop 后自动 end_turn,可再 begin。
#[test]
fn begin_turn_guard_reopens_on_drop() {
    let entry = test_entry();
    {
        let guard = entry.begin_turn();
        assert!(guard.is_some(), "空闲时 begin_turn 应得到守卫");
        assert!(
            entry.begin_turn().is_none(),
            "守卫存活期间再 begin_turn 应为 None(轮次进行中)"
        );
    } // guard drop → end_turn
    assert!(
        entry.begin_turn().is_some(),
        "守卫 drop 后 busy 应已清,可再次 begin_turn"
    );
}

// ── validate_agent_req ──

#[test]
fn validate_rejects_unknown_agent() {
    let dir = std::env::temp_dir();
    let cwd = dir.to_string_lossy();
    // AcpCommand 不实现 PartialEq,故用 matches! 只断言 Err 变体(不比较 Ok 载荷)。
    assert!(matches!(
        validate_agent_req("gpt", &cwd),
        Err(AgentReqError::UnsupportedAgent)
    ));
}

#[test]
fn validate_rejects_relative_or_missing_cwd() {
    // 相对路径。
    assert!(matches!(
        validate_agent_req("claude", "relative/path"),
        Err(AgentReqError::InvalidCwd)
    ));
    // 空。
    assert!(matches!(
        validate_agent_req("claude", ""),
        Err(AgentReqError::InvalidCwd)
    ));
    // 绝对但不存在。
    let missing = std::env::temp_dir().join(format!("meterm-agent-nope-{}", uuid::Uuid::new_v4()));
    assert!(matches!(
        validate_agent_req("claude", &missing.to_string_lossy()),
        Err(AgentReqError::InvalidCwd)
    ));
}

#[test]
fn validate_accepts_claude_with_valid_dir() {
    let dir = std::env::temp_dir();
    let cmd =
        validate_agent_req("claude", &dir.to_string_lossy()).expect("claude + 合法目录应通过");
    assert_eq!(cmd.program, "npx", "应返回 claude_code 的默认命令");
}
