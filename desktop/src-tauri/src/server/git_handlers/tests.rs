use super::*;

/// porcelain -b 解析:分支 + ahead/behind + 各类文件状态(修改/新增/untracked/重命名)。
#[test]
fn parses_porcelain_status() {
    let out = "## dev-0.2.12...origin/dev-0.2.12 [ahead 3, behind 1]\n M src/a.rs\nM  src/b.rs\n?? new.txt\nR  old.rs -> renamed.rs\n";
    let v = parse_git_status(out);
    assert_eq!(v["branch"], "dev-0.2.12");
    assert_eq!(v["ahead"], 3);
    assert_eq!(v["behind"], 1);
    let files = v["files"].as_array().unwrap();
    assert_eq!(files.len(), 4);
    assert_eq!(files[0]["path"], "src/a.rs");
    assert_eq!(files[0]["staged"], false);
    assert_eq!(files[0]["unstaged"], true);
    assert_eq!(files[1]["staged"], true);
    assert_eq!(files[1]["unstaged"], false);
    assert_eq!(files[2]["staged"], false);
    assert_eq!(files[2]["unstaged"], true);
    assert_eq!(files[3]["path"], "renamed.rs");
}

#[test]
fn parses_status_without_upstream() {
    let v = parse_git_status("## main\n");
    assert_eq!(v["branch"], "main");
    assert_eq!(v["ahead"], 0);
    assert!(v["files"].as_array().unwrap().is_empty());
    let v = parse_git_status("## No commits yet on main\n");
    assert_eq!(v["branch"], "main");
}

#[test]
fn rejects_bad_rel_paths() {
    assert!(rel_path_ok("src/a.rs"));
    assert!(rel_path_ok("a b/c.txt"));
    assert!(!rel_path_ok("/etc/passwd"));
    assert!(!rel_path_ok("../outside.txt"));
    assert!(!rel_path_ok("a/../../b"));
    assert!(!rel_path_ok(""));
}

#[tokio::test]
async fn git_subprocess_rejects_output_above_limit() {
    let dir = std::env::temp_dir().join(format!("meterm-git-limit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("before.txt"), "before\n").unwrap();
    std::fs::write(dir.join("after.txt"), "after\n".repeat(1024)).unwrap();

    let error = run_git_with_limits(
        dir.to_string_lossy().into_owned(),
        vec![
            "diff".into(),
            "--no-index".into(),
            "--".into(),
            "before.txt".into(),
            "after.txt".into(),
        ],
        128,
        128,
        Duration::from_secs(5),
    )
    .await
    .unwrap_err();

    assert!(error.contains("stdout exceeded 128 byte limit"), "{error}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn git_roundtrip_in_temp_repo() {
    let dir = std::env::temp_dir().join(format!("meterm-git-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let cwd = dir.to_string_lossy().into_owned();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .args(args)
            .current_dir(&dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-b", "main"]);
    std::fs::write(dir.join("a.txt"), "hello\n").unwrap();

    let (ok, stdout, _) = run_git(
        cwd.clone(),
        vec!["status".into(), "--porcelain=v1".into(), "-b".into()],
    )
    .await
    .unwrap();
    assert!(ok);
    let v = parse_git_status(&stdout);
    assert_eq!(v["branch"], "main");
    assert_eq!(v["files"][0]["path"], "a.txt");
    assert_eq!(v["files"][0]["status"], "??");

    git(&["add", "-A"]);
    git(&[
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-m",
        "首次提交",
    ]);
    let (ok, stdout, _) = run_git(
        cwd.clone(),
        vec![
            "log".into(),
            "--pretty=format:%h%x1f%s%x1f%an%x1f%cr".into(),
            "-n5".into(),
        ],
    )
    .await
    .unwrap();
    assert!(ok);
    assert!(stdout.contains("首次提交"));

    let _ = std::fs::remove_dir_all(&dir);
}
