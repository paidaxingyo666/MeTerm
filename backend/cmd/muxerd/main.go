package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	addr := flag.String("addr", "http://localhost:8080", "base API address")
	flag.Parse()

	args := flag.Args()
	if len(args) < 2 || args[0] != "sessions" {
		return fmt.Errorf("usage: meterm [--addr URL] sessions <ls|inspect|kill> [id]")
	}

	base := strings.TrimRight(*addr, "/")

	switch args[1] {
	case "ls":
		if len(args) != 2 {
			return fmt.Errorf("usage: meterm [--addr URL] sessions ls")
		}
		return listSessions(base)
	case "inspect":
		if len(args) != 3 {
			return fmt.Errorf("usage: meterm [--addr URL] sessions inspect <id>")
		}
		return inspectSession(base, args[2])
	case "kill":
		if len(args) != 3 {
			return fmt.Errorf("usage: meterm [--addr URL] sessions kill <id>")
		}
		return killSession(base, args[2])
	default:
		return fmt.Errorf("unknown subcommand: %s", args[1])
	}
}

func listSessions(base string) error {
	resp, err := http.Get(base + "/api/sessions")
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("request failed: %s", resp.Status)
	}

	var payload struct {
		Sessions []struct {
			ID        string `json:"id"`
			State     string `json:"state"`
			Clients   int    `json:"clients"`
			MasterID  string `json:"master_id"`
			CreatedAt string `json:"created_at"`
		} `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return err
	}

	tw := tabwriter.NewWriter(os.Stdout, 2, 8, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tSTATE\tCLIENTS\tMASTER\tCREATED")
	for _, s := range payload.Sessions {
		fmt.Fprintf(tw, "%s\t%s\t%d\t%s\t%s\n", s.ID, s.State, s.Clients, s.MasterID, s.CreatedAt)
	}
	return tw.Flush()
}

func inspectSession(base, id string) error {
	resp, err := http.Get(base + "/api/sessions/" + id)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("request failed: %s", resp.Status)
	}

	var payload map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return err
	}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

func killSession(base, id string) error {
	req, err := http.NewRequest(http.MethodDelete, base+"/api/sessions/"+id, nil)
	if err != nil {
		return err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("request failed: %s", resp.Status)
	}

	fmt.Println("killed")
	return nil
}
