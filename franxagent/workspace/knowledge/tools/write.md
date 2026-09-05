### `write` - Propose file content changes (proposal-review-overwrite mode)
Used when the AI wants to create a new file, write content to an existing file, or modify a file. The write tool never performs file operations directly: it returns the AI's suggested complete file content as a string; a review gate decides approve/reject; approved content is written and the final content is fed back to the AI.
Input: {"path": "...", "content": "...", "mode": "overwrite|insert|edit", "start_line": 0, "end_line": 0}.
Line numbers MUST come from the most recent read. One read, one edit. Always paired.
