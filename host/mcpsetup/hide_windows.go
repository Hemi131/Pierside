package main

import (
	"os/exec"
	"syscall"
)

// hide keeps the assistant's CLI from flashing a console window.
func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
