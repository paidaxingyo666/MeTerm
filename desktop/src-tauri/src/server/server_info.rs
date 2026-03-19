//! Server info handler — mirrors Go `api/server_info.go`.
//!
//! For SSH sessions: runs sysinfo/process scripts via SSH exec channel.
//! For local sessions: returns local system info via sysinfo crate.

use std::sync::Arc;

use super::protocol;
use super::session::Session;
use super::terminal::ssh;

/// Cross-platform sysinfo shell script (matches Go's sysinfoScript).
const SYSINFO_SCRIPT: &str = r#"
echo "HOSTNAME=$(hostname 2>/dev/null || echo unknown)"
echo "OS_TYPE=$(uname -s 2>/dev/null || echo unknown)"
echo "KERNEL=$(uname -r 2>/dev/null || echo unknown)"
echo "ARCH=$(uname -m 2>/dev/null || echo unknown)"
if [ -f /etc/os-release ]; then . /etc/os-release 2>/dev/null; echo "OS_NAME=$PRETTY_NAME"; elif command -v sw_vers >/dev/null 2>&1; then echo "OS_NAME=$(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null)"; else echo "OS_NAME=$(uname -s 2>/dev/null)"; fi
echo "CPU_CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)"
cm=$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | sed 's/.*: //'); [ -z "$cm" ] && cm=$(sysctl -n machdep.cpu.brand_string 2>/dev/null); [ -z "$cm" ] && cm="unknown"; echo "CPU_MODEL=$cm"
if [ -f /proc/stat ]; then c1=$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8}' /proc/stat); sleep 1; c2=$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8}' /proc/stat); echo "$c1" "$c2" | awk '{u1=$1+$3;t1=$1+$2+$3+$4+$5+$6+$7;u2=$8+$10;t2=$8+$9+$10+$11+$12+$13+$14;dt=t2-t1;if(dt>0)printf "CPU_USAGE=%.1f\n",(u2-u1)/dt*100;else print "CPU_USAGE=0"}'; elif command -v top >/dev/null 2>&1; then top -l1 -n0 -s0 2>/dev/null | awk '/CPU usage/{gsub(/%/,"",$7);printf "CPU_USAGE=%.1f\n",100-$7}'; else echo "CPU_USAGE=0"; fi
if [ -f /proc/meminfo ]; then awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}/^MemFree:/{f=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}END{if(a>0){u=t-a}else{u=t-f-b-c};printf "MEM_TOTAL=%.0f\nMEM_USED=%.0f\n",t*1024,u*1024}' /proc/meminfo; elif command -v sysctl >/dev/null 2>&1; then t=$(sysctl -n hw.memsize 2>/dev/null||echo 0);echo "MEM_TOTAL=$t";p=$(vm_stat 2>/dev/null|awk '/Pages active/{a=$3}/Pages wired/{w=$3}/Pages occupied by compressor/{c=$3}END{gsub(/\./,"",a);gsub(/\./,"",w);gsub(/\./,"",c);printf "%.0f\n",(a+w+c)*4096}');echo "MEM_USED=${p:-0}"; fi
df -kP 2>/dev/null | awk 'NR>1 && $1 ~ /^\// {printf "DISK=%s|%.0f|%.0f|%.0f\n",$6,$2*1024,$3*1024,$4*1024}'
if [ -f /proc/net/dev ]; then awk '/^ *[a-z]/ && !/^ *lo:/ {gsub(/:/, " "); printf "NET=%s|%.0f|%.0f\n",$1,$2,$10}' /proc/net/dev 2>/dev/null; fi
if [ -f /proc/uptime ]; then echo "UPTIME_SECS=$(cut -d. -f1 /proc/uptime 2>/dev/null)"; elif command -v sysctl >/dev/null 2>&1; then bt=$(sysctl -n kern.boottime 2>/dev/null|sed 's/.*sec = \([0-9]*\).*/\1/');now=$(date +%s);echo "UPTIME_SECS=$((now-bt))"; else echo "UPTIME_SECS=0"; fi
"#;

/// Process list command (matches Go's processListCmd).
const PROCESS_LIST_CMD: &str = "ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu --no-headers 2>/dev/null | head -30 || ps -eo pid,user,%cpu,%mem,etime,comm -r 2>/dev/null | tail -n +2 | head -30";

/// Handle MsgServerInfo request. Returns the response as a protocol message.
pub async fn handle_server_info(session: &Session, payload: &[u8]) -> Vec<u8> {
    // Parse request type
    let req_type = serde_json::from_slice::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_else(|| "sysinfo".to_string());

    let exec_type = session.executor_type.lock().unwrap().clone();
    if exec_type != "ssh" {
        // Local session — return local info
        return handle_local_server_info(&req_type);
    }

    // SSH session — run commands via exec channel
    let handle_guard = session.ssh_exec_handle.lock().await;
    let handle = match handle_guard.as_ref() {
        Some(h) => h,
        None => {
            let err = serde_json::json!({"type": "error", "code": "SSH_NOT_AVAILABLE", "message": "SSH exec not available"});
            return protocol::encode_message(protocol::MSG_SERVER_INFO, serde_json::to_vec(&err).unwrap_or_default().as_slice());
        }
    };

    // Downcast to the actual type
    let ssh_handle = match handle.downcast_ref::<Arc<tokio::sync::Mutex<Option<russh::client::Handle<ssh::SshHandler>>>>>() {
        Some(h) => h,
        None => {
            let err = serde_json::json!({"type": "error", "code": "INTERNAL", "message": "invalid SSH handle type"});
            return protocol::encode_message(protocol::MSG_SERVER_INFO, serde_json::to_vec(&err).unwrap_or_default().as_slice());
        }
    };

    match req_type.as_str() {
        "processes" => {
            match ssh::ssh_exec(ssh_handle, PROCESS_LIST_CMD, 5).await {
                Ok(output) => {
                    let processes = parse_process_output(&output);
                    let resp = serde_json::json!({"type": "processes", "processes": processes});
                    protocol::encode_message(protocol::MSG_SERVER_INFO, serde_json::to_vec(&resp).unwrap_or_default().as_slice())
                }
                Err(e) => {
                    let err = serde_json::json!({"type": "error", "code": "EXEC_FAILED", "message": e});
                    protocol::encode_message(protocol::MSG_SERVER_INFO, serde_json::to_vec(&err).unwrap_or_default().as_slice())
                }
            }
        }
        _ => {
            // sysinfo
            match ssh::ssh_exec(ssh_handle, SYSINFO_SCRIPT, 10).await {
                Ok(output) => {
                    let info = parse_sysinfo_output(&output);
                    protocol::encode_message(protocol::MSG_SERVER_INFO, serde_json::to_vec(&info).unwrap_or_default().as_slice())
                }
                Err(e) => {
                    let err = serde_json::json!({"type": "error", "code": "EXEC_FAILED", "message": e});
                    protocol::encode_message(protocol::MSG_SERVER_INFO, serde_json::to_vec(&err).unwrap_or_default().as_slice())
                }
            }
        }
    }
}

fn handle_local_server_info(req_type: &str) -> Vec<u8> {
    let resp = serde_json::json!({
        "type": req_type,
        "hostname": hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default(),
        "os_type": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    });
    protocol::encode_message(protocol::MSG_SERVER_INFO, serde_json::to_vec(&resp).unwrap_or_default().as_slice())
}

/// Parse sysinfo script output (key=value lines) — matches Go parseSysinfoOutput.
fn parse_sysinfo_output(output: &str) -> serde_json::Value {
    let mut info = serde_json::json!({"type": "sysinfo"});
    let mut disks = Vec::new();
    let mut net_ifaces = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        let Some(idx) = line.find('=') else { continue };
        let key = &line[..idx];
        let val = &line[idx + 1..];
        match key {
            "HOSTNAME" => { info["hostname"] = val.into(); }
            "OS_TYPE" => { info["os_type"] = val.into(); }
            "OS_NAME" => { info["os_name"] = val.into(); }
            "KERNEL" => { info["kernel"] = val.into(); }
            "ARCH" => { info["arch"] = val.into(); }
            "CPU_CORES" => { info["cpu_cores"] = val.parse::<i64>().unwrap_or(1).into(); }
            "CPU_MODEL" => { info["cpu_model"] = val.into(); }
            "CPU_USAGE" => { info["cpu_usage"] = val.parse::<f64>().unwrap_or(0.0).into(); }
            "MEM_TOTAL" => { info["mem_total"] = val.parse::<i64>().unwrap_or(0).into(); }
            "MEM_USED" => { info["mem_used"] = val.parse::<i64>().unwrap_or(0).into(); }
            "UPTIME_SECS" => { info["uptime_seconds"] = val.parse::<i64>().unwrap_or(0).into(); }
            "DISK" => {
                let parts: Vec<&str> = val.splitn(4, '|').collect();
                if parts.len() == 4 {
                    disks.push(serde_json::json!({
                        "mount": parts[0],
                        "total": parts[1].parse::<i64>().unwrap_or(0),
                        "used": parts[2].parse::<i64>().unwrap_or(0),
                        "available": parts[3].parse::<i64>().unwrap_or(0),
                    }));
                }
            }
            "NET" => {
                let parts: Vec<&str> = val.splitn(3, '|').collect();
                if parts.len() == 3 {
                    net_ifaces.push(serde_json::json!({
                        "name": parts[0],
                        "rx_bytes": parts[1].parse::<i64>().unwrap_or(0),
                        "tx_bytes": parts[2].parse::<i64>().unwrap_or(0),
                    }));
                }
            }
            _ => {}
        }
    }

    info["disks"] = disks.into();
    info["net_ifaces"] = net_ifaces.into();
    info
}

/// Parse process list output — matches Go parseProcessOutput.
fn parse_process_output(output: &str) -> Vec<serde_json::Value> {
    output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 6 { return None; }
            Some(serde_json::json!({
                "pid": fields[0].parse::<i32>().unwrap_or(0),
                "user": fields[1],
                "cpu": fields[2].parse::<f64>().unwrap_or(0.0),
                "mem": fields[3].parse::<f64>().unwrap_or(0.0),
                "time": fields[4],
                "command": fields[5..].join(" "),
            }))
        })
        .collect()
}
