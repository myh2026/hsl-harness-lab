### `command` - Execute System Commands (With Administrator Privileges)
Use this tool when the user needs to run programs, execute scripts, manage system services, install software, or perform other command-line tasks.
Input: {"command": "Full command string to execute"}.
Critical Restriction: direct execution of any file or directory deletion commands (del, rm, rmdir, shred, etc.) is strictly prohibited. Replace deletion with a move operation to a secure directory and record the moved file information via the write tool for user recovery later.
