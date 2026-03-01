package protocol

// File management message types
const (
	MsgFileList          byte = 0x0A
	MsgFileListResp      byte = 0x0B
	MsgFileUploadStart   byte = 0x0C
	MsgFileUploadChunk   byte = 0x0D
	MsgFileDownloadStart byte = 0x0E
	MsgFileDownloadChunk byte = 0x0F
	MsgFileOperation     byte = 0x10
	MsgFileOperationResp byte = 0x11
	MsgServerInfo         byte = 0x12
	MsgTransferProgress   byte = 0x13
	MsgFileUploadResume   byte = 0x14
	MsgFileDownloadResume byte = 0x15
	MsgFileListProgress     byte = 0x16
	MsgSetEncoding          byte = 0x17
	MsgFileDownloadPause    byte = 0x20 // client → server: pause active download
	MsgFileDownloadContinue byte = 0x21 // client → server: resume paused download
	MsgFileDownloadCancel   byte = 0x22 // client → server: cancel active download
)

// FileInfo represents a file or directory metadata
type FileInfo struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime int64  `json:"mtime"`
	IsDir   bool   `json:"is_dir"`
	Owner   string `json:"owner"`
	Group   string `json:"group"`
	IsLink  bool   `json:"is_link,omitempty"`
}

// FileListRequest payload
type FileListRequest struct {
	Path string `json:"path"`
}

// FileListResponse payload
type FileListResponse struct {
	Path  string     `json:"path"`
	Files []FileInfo `json:"files"`
}

// ServerInfoRequest payload
type ServerInfoRequest struct {
	Type string `json:"type"` // "sysinfo" or "processes"
}

// DiskInfo represents a single mounted filesystem
type DiskInfo struct {
	Mount     string `json:"mount"`
	Total     int64  `json:"total"`
	Used      int64  `json:"used"`
	Available int64  `json:"available"`
}

// NetIfaceInfo represents cumulative bytes for a network interface
type NetIfaceInfo struct {
	Name    string `json:"name"`
	RxBytes int64  `json:"rx_bytes"`
	TxBytes int64  `json:"tx_bytes"`
}

// ServerInfoResponse payload for system info
type ServerInfoResponse struct {
	Type          string     `json:"type"`
	Hostname      string     `json:"hostname"`
	OSType        string     `json:"os_type"`
	OSName        string     `json:"os_name"`
	Kernel        string     `json:"kernel"`
	Arch          string     `json:"arch"`
	UptimeSeconds int64      `json:"uptime_seconds"`
	CPUModel      string     `json:"cpu_model"`
	CPUCores      int        `json:"cpu_cores"`
	CPUUsage      float64    `json:"cpu_usage"`
	MemTotal      int64      `json:"mem_total"`
	MemUsed       int64      `json:"mem_used"`
	Disks         []DiskInfo    `json:"disks"`
	NetIfaces     []NetIfaceInfo `json:"net_ifaces,omitempty"`
}

// ProcessInfo represents a single process
type ProcessInfo struct {
	PID     int     `json:"pid"`
	User    string  `json:"user"`
	CPU     float64 `json:"cpu"`
	Mem     float64 `json:"mem"`
	Time    string  `json:"time"`
	Command string  `json:"command"`
}

// ProcessListResponse payload for process list
type ProcessListResponse struct {
	Type      string        `json:"type"`
	Processes []ProcessInfo `json:"processes"`
}

// ErrorResponse for file operations
type ErrorResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

// FileListProgressResponse for large directory loading progress
type FileListProgressResponse struct {
	Loaded int `json:"loaded"`
	Total  int `json:"total"`
}
