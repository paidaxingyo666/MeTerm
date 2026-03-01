package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/paidaxingyo666/meterm/protocol"
	"github.com/paidaxingyo666/meterm/session"
)

// sshExec runs a command on the remote server via a new SSH exec channel.
func sshExec(client *ssh.Client, cmd string, timeout time.Duration) (string, error) {
	sess, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("failed to create session: %w", err)
	}
	defer sess.Close()

	var stdout, stderr bytes.Buffer
	sess.Stdout = &stdout
	sess.Stderr = &stderr

	done := make(chan error, 1)
	go func() { done <- sess.Run(cmd) }()

	select {
	case err := <-done:
		if err != nil && stdout.Len() == 0 {
			return "", fmt.Errorf("command failed: %w, stderr: %s", err, stderr.String())
		}
		return stdout.String(), nil
	case <-time.After(timeout):
		return stdout.String(), fmt.Errorf("command timed out")
	}
}

// sysinfoScript is a cross-platform shell script that outputs key=value pairs.
const sysinfoScript = `
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
`

func parseSysinfoOutput(output string) protocol.ServerInfoResponse {
	info := protocol.ServerInfoResponse{Type: "sysinfo"}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		idx := strings.Index(line, "=")
		if idx < 0 {
			continue
		}
		key := line[:idx]
		val := line[idx+1:]
		switch key {
		case "HOSTNAME":
			info.Hostname = val
		case "OS_TYPE":
			info.OSType = val
		case "OS_NAME":
			info.OSName = val
		case "KERNEL":
			info.Kernel = val
		case "ARCH":
			info.Arch = val
		case "CPU_CORES":
			if n, err := strconv.Atoi(val); err == nil {
				info.CPUCores = n
			}
		case "CPU_MODEL":
			info.CPUModel = val
		case "CPU_USAGE":
			if f, err := strconv.ParseFloat(val, 64); err == nil {
				info.CPUUsage = f
			}
		case "MEM_TOTAL":
			if n, err := strconv.ParseInt(val, 10, 64); err == nil {
				info.MemTotal = n
			}
		case "MEM_USED":
			if n, err := strconv.ParseInt(val, 10, 64); err == nil {
				info.MemUsed = n
			}
		case "NET":
			// val format: name|rx_bytes|tx_bytes
			parts := strings.SplitN(val, "|", 3)
			if len(parts) == 3 {
				rx, _ := strconv.ParseInt(parts[1], 10, 64)
				tx, _ := strconv.ParseInt(parts[2], 10, 64)
				info.NetIfaces = append(info.NetIfaces, protocol.NetIfaceInfo{
					Name: parts[0], RxBytes: rx, TxBytes: tx,
				})
			}
		case "DISK":
			// val format: mount|total|used|available
			parts := strings.SplitN(val, "|", 4)
			if len(parts) == 4 {
				total, _ := strconv.ParseInt(parts[1], 10, 64)
				used, _ := strconv.ParseInt(parts[2], 10, 64)
				avail, _ := strconv.ParseInt(parts[3], 10, 64)
				info.Disks = append(info.Disks, protocol.DiskInfo{
					Mount:     parts[0],
					Total:     total,
					Used:      used,
					Available: avail,
				})
			}
		case "UPTIME_SECS":
			if n, err := strconv.ParseInt(val, 10, 64); err == nil {
				info.UptimeSeconds = n
			}
		}
	}
	return info
}

// processListCmd outputs processes sorted by CPU, compatible with Linux and macOS.
const processListCmd = `ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu --no-headers 2>/dev/null | head -30 || ps -eo pid,user,%cpu,%mem,etime,comm -r 2>/dev/null | tail -n +2 | head -30`

func parseProcessOutput(output string) protocol.ProcessListResponse {
	resp := protocol.ProcessListResponse{Type: "processes"}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		pid, _ := strconv.Atoi(fields[0])
		cpu, _ := strconv.ParseFloat(fields[2], 64)
		mem, _ := strconv.ParseFloat(fields[3], 64)
		cmd := strings.Join(fields[5:], " ")
		resp.Processes = append(resp.Processes, protocol.ProcessInfo{
			PID:     pid,
			User:    fields[1],
			CPU:     cpu,
			Mem:     mem,
			Time:    fields[4],
			Command: cmd,
		})
	}
	return resp
}

// handleServerInfo processes a MsgServerInfo request and returns a response.
func handleServerInfo(s *session.Session, payload []byte) []byte {
	if s.SFTPClient == nil {
		errResp := protocol.ErrorResponse{Code: "SSH_NOT_AVAILABLE", Message: "SSH connection not available"}
		data, _ := json.Marshal(errResp)
		return protocol.EncodeMessage(protocol.MsgServerInfo, data)
	}

	sshClient := s.SFTPClient.SSHClient()
	if sshClient == nil {
		errResp := protocol.ErrorResponse{Code: "SSH_NOT_AVAILABLE", Message: "SSH client not available"}
		data, _ := json.Marshal(errResp)
		return protocol.EncodeMessage(protocol.MsgServerInfo, data)
	}

	var req protocol.ServerInfoRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		req.Type = "sysinfo" // default
	}

	switch req.Type {
	case "processes":
		output, err := sshExec(sshClient, processListCmd, 5*time.Second)
		if err != nil {
			log.Printf("[ServerInfo] process list error: %v", err)
		}
		resp := parseProcessOutput(output)
		data, _ := json.Marshal(resp)
		return protocol.EncodeMessage(protocol.MsgServerInfo, data)

	default: // "sysinfo"
		output, err := sshExec(sshClient, sysinfoScript, 10*time.Second)
		if err != nil {
			log.Printf("[ServerInfo] sysinfo error: %v", err)
		}
		debugLog("[ServerInfo] raw output:\n%s", output)
		resp := parseSysinfoOutput(output)
		debugLog("[ServerInfo] parsed: cpu=%.1f%% mem=%d/%d disks=%d",
			resp.CPUUsage, resp.MemUsed, resp.MemTotal, len(resp.Disks))
		data, _ := json.Marshal(resp)
		return protocol.EncodeMessage(protocol.MsgServerInfo, data)
	}
}
