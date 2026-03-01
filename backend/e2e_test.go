package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/paidaxingyo666/meterm/protocol"
	"github.com/gorilla/websocket"
)

const testBaseURL = "http://localhost:19879"
const testWSURL = "ws://localhost:19879"

func testToken() string {
	return strings.TrimSpace(os.Getenv("METERM_TEST_TOKEN"))
}

func authRequest(req *http.Request) {
	if token := testToken(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

func createSession(t *testing.T) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, testBaseURL+"/api/sessions", nil)
	if err != nil {
		t.Fatalf("create session request: %v", err)
	}
	authRequest(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create session status %d: %s", resp.StatusCode, body)
	}
	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	id, ok := result["id"].(string)
	if !ok || id == "" {
		t.Fatal("no session id returned")
	}
	return id
}

func connectWS(t *testing.T, sessionID string, clientID string) *websocket.Conn {
	t.Helper()
	url := fmt.Sprintf("%s/ws/%s", testWSURL, sessionID)
	if clientID != "" {
		url += "?client_id=" + clientID
	}
	headers := http.Header{}
	if token := testToken(); token != "" {
		headers.Set("Authorization", "Bearer "+token)
		headers.Set("Sec-WebSocket-Protocol", "meterm.v1, bearer."+token)
	}
	conn, _, err := websocket.DefaultDialer.Dial(url, headers)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	return conn
}

func readHello(t *testing.T, conn *websocket.Conn) (clientID, role string) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read hello: %v", err)
	}
	msgType, payload, err := protocol.DecodeMessage(data)
	if err != nil {
		t.Fatalf("decode hello: %v", err)
	}
	if msgType != protocol.MsgHello {
		t.Fatalf("expected MsgHello (0x09), got 0x%02x", msgType)
	}
	var hello map[string]interface{}
	if err := json.Unmarshal(payload, &hello); err != nil {
		t.Fatalf("parse hello JSON: %v", err)
	}

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = conn.ReadMessage()

	return hello["client_id"].(string), hello["role"].(string)
}

func readOutputContaining(t *testing.T, conn *websocket.Conn, substr string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var accumulated strings.Builder
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		_, data, err := conn.ReadMessage()
		if err != nil {
			continue
		}
		msgType, payload, err := protocol.DecodeMessage(data)
		if err != nil {
			continue
		}
		if msgType == protocol.MsgOutput {
			accumulated.Write(payload)
			if strings.Contains(accumulated.String(), substr) {
				return accumulated.String()
			}
		}
	}
	t.Fatalf("timeout: never received output containing %q, got: %q", substr, accumulated.String())
	return ""
}

func TestE2E_BasicFlow(t *testing.T) {
	// 1. Create session
	sessionID := createSession(t)
	t.Logf("Created session: %s", sessionID)

	// 2. Connect WebSocket
	conn := connectWS(t, sessionID, "")
	defer conn.Close()

	// 3. Read MsgHello
	clientID, role := readHello(t, conn)
	t.Logf("Hello: clientID=%s role=%s", clientID, role)
	if role != "master" {
		t.Fatalf("expected role=master, got %s", role)
	}

	input := protocol.EncodeMessage(protocol.MsgInput, []byte("echo hello-e2e\n"))
	if err := conn.WriteMessage(websocket.BinaryMessage, input); err != nil {
		t.Fatalf("write input: %v", err)
	}

	// 6. Read output until "hello-e2e" appears
	output := readOutputContaining(t, conn, "hello-e2e", 5*time.Second)
	t.Logf("Output received (contains hello-e2e): len=%d", len(output))

	// 7. Send resize
	resize := protocol.EncodeResize(120, 40)
	if err := conn.WriteMessage(websocket.BinaryMessage, resize); err != nil {
		t.Fatalf("write resize: %v", err)
	}

	// 8. Send ping
	ping := protocol.EncodeMessage(protocol.MsgPing, nil)
	if err := conn.WriteMessage(websocket.BinaryMessage, ping); err != nil {
		t.Fatalf("write ping: %v", err)
	}

	// Read pong
	deadline := time.Now().Add(3 * time.Second)
	gotPong := false
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		_, data, err := conn.ReadMessage()
		if err != nil {
			continue
		}
		msgType, _, _ := protocol.DecodeMessage(data)
		if msgType == protocol.MsgPong {
			gotPong = true
			break
		}
	}
	if !gotPong {
		t.Fatal("did not receive pong")
	}
	t.Log("Ping/Pong OK")
}

func TestE2E_MultiClient(t *testing.T) {
	sessionID := createSession(t)

	// Client 1 (master)
	conn1 := connectWS(t, sessionID, "")
	defer conn1.Close()
	id1, role1 := readHello(t, conn1)
	t.Logf("Client1: id=%s role=%s", id1, role1)
	if role1 != "master" {
		t.Fatalf("expected master, got %s", role1)
	}

	// Client 2 (viewer)
	conn2 := connectWS(t, sessionID, "")
	defer conn2.Close()
	id2, role2 := readHello(t, conn2)
	t.Logf("Client2: id=%s role=%s", id2, role2)
	if role2 != "viewer" {
		t.Fatalf("expected viewer, got %s", role2)
	}

	// Master sends input
	input := protocol.EncodeMessage(protocol.MsgInput, []byte("echo multi-test\n"))
	if err := conn1.WriteMessage(websocket.BinaryMessage, input); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Both should receive output
	readOutputContaining(t, conn1, "multi-test", 5*time.Second)
	readOutputContaining(t, conn2, "multi-test", 5*time.Second)
	t.Log("Multi-client broadcast OK")
}

func TestE2E_Reconnect(t *testing.T) {
	sessionID := createSession(t)

	// Connect
	conn1 := connectWS(t, sessionID, "")
	clientID, role := readHello(t, conn1)
	t.Logf("Initial: id=%s role=%s", clientID, role)

	// Disconnect
	conn1.Close()
	time.Sleep(1 * time.Second)

	// Reconnect with same client_id
	conn2 := connectWS(t, sessionID, clientID)
	defer conn2.Close()
	reconnID, reconnRole := readHello(t, conn2)
	t.Logf("Reconnect: id=%s role=%s", reconnID, reconnRole)

	if reconnID != clientID {
		t.Fatalf("reconnect id mismatch: %s != %s", reconnID, clientID)
	}
	if reconnRole != "master" {
		t.Fatalf("expected master after reconnect, got %s", reconnRole)
	}

	// Verify terminal still works
	input := protocol.EncodeMessage(protocol.MsgInput, []byte("echo reconn-ok\n"))
	if err := conn2.WriteMessage(websocket.BinaryMessage, input); err != nil {
		t.Fatalf("write: %v", err)
	}
	readOutputContaining(t, conn2, "reconn-ok", 5*time.Second)
	t.Log("Reconnect OK")
}

func TestE2E_SessionDelete(t *testing.T) {
	sessionID := createSession(t)
	conn := connectWS(t, sessionID, "")
	defer conn.Close()
	readHello(t, conn)

	req, _ := http.NewRequest(http.MethodDelete, testBaseURL+"/api/sessions/"+sessionID, nil)
	authRequest(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete status: %d", resp.StatusCode)
	}

	getReq, err := http.NewRequest(http.MethodGet, testBaseURL+"/api/sessions/"+sessionID, nil)
	if err != nil {
		t.Fatal(err)
	}
	authRequest(getReq)
	getResp, err := http.DefaultClient.Do(getReq)
	if err != nil {
		t.Fatal(err)
	}
	defer getResp.Body.Close()
	if getResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d", getResp.StatusCode)
	}
	t.Log("Delete OK")
}
