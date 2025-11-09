class E2EAgent {
  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || "";
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }
    this.baseUrl = "https://api.anthropic.com/v1/messages";
  }

  async read_file(path) {
    const fs = await import("fs/promises");
    try {
      const content = await fs.readFile(path, "utf-8");
      return content;
    } catch (error) {
      if (error.code === "ENOENT") {
        return { error: "File not found", path, exists: false };
      }
      if (error.code === "EACCES") {
        return { error: "Permission denied", path, exists: true };
      }
      return { error: error.message, path };
    }
  }

  async write_file(path, content) {
    const fs = await import("fs/promises");
    const pathModule = await import("path");
    try {
      // Create parent directories if they don't exist
      const dir = pathModule.dirname(path);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, content, "utf-8");
    } catch (error) {
      throw new Error(`Failed to write file ${path}: ${error}`);
    }
  }

  async think(thought) {
    console.log(`[THINK] ${thought}`);
  }

  async run_command(command, cwd) {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(command, { cwd });
      return { stdout, stderr, success: true };
    } catch (error) {
      return {
        stdout: error.stdout,
        stderr: error.stderr,
        success: false,
        error: error.message,
      };
    }
  }

  async list_directory(path) {
    const fs = await import("fs/promises");
    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    } catch (error) {
      if (error.code === "ENOENT") {
        return { error: "Directory not found", path, exists: false };
      }
      if (error.code === "EACCES") {
        return { error: "Permission denied", path, exists: true };
      }
      if (error.code === "ENOTDIR") {
        return { error: "Path is not a directory", path, exists: true };
      }
      return { error: error.message, path };
    }
  }

  async grep(pattern, path, options = {}) {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      // Build rg command with options
      let command = `rg "${pattern.replace(/"/g, '\\"')}" "${path}"`;

      if (options.case_insensitive) {
        command += " -i";
      }
      if (options.files_with_matches) {
        command += " -l";
      }
      if (options.line_numbers !== false) {
        command += " -n";
      }
      if (options.context) {
        command += ` -C ${options.context}`;
      }

      const { stdout } = await execAsync(command);
      return { success: true, results: stdout };
    } catch (error) {
      // rg returns exit code 1 when no matches found
      if (error.code === 1) {
        return { success: true, results: "No matches found" };
      }
      return { success: false, error: error.message, stderr: error.stderr };
    }
  }

  async summarize(text) {
    try {
      console.log("[SUMMARIZING] Compressing conversation history...");
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "tools-2024-04-04",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 5_000,
          messages: [
            {
              role: "user",
              content: `You are compressing a conversation history for a codebase analysis agent. Create a highly structured, information-dense summary that preserves all critical details.

PRESERVE EXACTLY:
- All file paths that were read, written, or analyzed
- All directory structures explored
- Key findings about the codebase architecture
- Feature sets identified and their associated files
- Any decisions made about feature ordering or git commits
- Command executions and their outcomes
- Code patterns, dependencies, and relationships discovered

FORMAT THE SUMMARY AS:
## Files Analyzed
[List all file paths]

## Codebase Understanding
[Architecture, tech stack, dependencies]

## Feature Sets Identified
[Each feature with its files]

## Progress & Actions Taken
[What's been done: files written, commands run, commits made]

## Next Steps
[What remains to be done]

Keep it concise but preserve ALL actionable information. Remove only conversational fluff.

CONVERSATION TO SUMMARIZE:
${text}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Summarization failed: ${response.status}`);
      }

      const data = await response.json();
      return data.content[0].text;
    } catch (error) {
      console.error("[SUMMARIZATION ERROR]", error.message);
      return text; // Return original if summarization fails
    }
  }

  async tool(toolName, parameters) {
    switch (toolName) {
      case "read_file":
        return await this.read_file(parameters.path);
      case "write_file":
        return await this.write_file(parameters.path, parameters.content);
      case "run_command":
        return await this.run_command(parameters.command, parameters.cwd);
      case "list_directory":
        return await this.list_directory(parameters.path);
      case "grep":
        return await this.grep(
          parameters.pattern,
          parameters.path,
          parameters.options
        );
      case "summarize":
        return await this.summarize(parameters.text);
      case "thinking":
        await this.think(parameters.thought);
        return { success: true };
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async run(projectPath) {
    try {
      // Get tree output for initial context
      let treeOutput = "";
      try {
        const treeResult = await this.run_command(
          `tree -L 2 "${projectPath}"`,
          projectPath
        );
        if (treeResult.success) {
          // Truncate to first 30 lines
          const lines = treeResult.stdout.split("\n");
          if (lines.length > 30) {
            treeOutput = lines.slice(0, 30).join("\n") + "\n... (truncated)";
          } else {
            treeOutput = treeResult.stdout;
          }
        }
      } catch (error) {
        console.log("Warning: Could not generate tree output");
      }

      const systemPrompt = `You are an expert software archaeologist and code historian. Your task is to analyze a codebase and reconstruct its development history.

## YOUR MISSION:

1. **ANALYZE THE CODEBASE & USE AGENT_INFO.md AS YOUR NOTEPAD**
   - Create AGENT_INFO.md in the project root IMMEDIATELY
   - As you explore, continuously WRITE to AGENT_INFO.md:
     * What you've discovered about the project
     * Architecture and tech stack findings
     * Dependencies and file relationships
   - Use the 'thinking' tool for quick observations
   - Use write_file to AGENT_INFO.md for important findings you want to remember

2. **IDENTIFY & DOCUMENT FEATURES INCREMENTALLY**
   - As you discover each feature, IMMEDIATELY write it to AGENT_INFO.md
   - For each feature discovered, append to AGENT_INFO.md:
     ## Feature: <Name>
     - **Description**: What this feature does
     - **Files involved**: List all files
     - **Dependencies**: What must exist first
     - **Reasoning**: Why this is a distinct feature
   
   - Keep updating AGENT_INFO.md as you learn more
   - Think of it as your scratchpad - write freely

3. **DETERMINE AUTHORING ORDER IN AGENT_INFO.md**
   - **FIRST**: Use the thinking tool to plan time estimates for all commits
     * Estimate 0.5h - 3h per commit (most commits 1-2.5 hours)
     * Total must be **AT LEAST 30 hours** (can go up to 36 hours)
     * Track cumulative hours to calculate timestamps
   
   - Once you've identified all features, add a section to AGENT_INFO.md:
     ## BUILD ORDER (30-36 Hour Hackathon - Nov 8-10, 2025)
     Break the project into 10-20+ small commits:
     
     1. "init commit lets gooo" (~50 lines, 0.5h)
        - Time: 0.5h (cumulative: 0.5h)
        - Timestamp: 2025-11-08T21:00:17 ← random seconds
        - Files: package.json, README.md, basic folder structure
     
     2. "server setup" (~80 lines, 1h)
        - Time: 1h (cumulative: 1.5h)
        - Timestamp: 2025-11-08T22:30:42 ← random seconds
        - Files: server.js (express setup + one route)
     
     3. "auth kinda wrking???" (~150 lines, 2.5h) ← note typo
        - Time: 2.5h (cumulative: 4h)
        - Timestamp: 2025-11-09T01:00:38 ← random seconds
        - Files: server.js (add auth endpoint), frontend.js (add login form)
     
     4. "db models donee" (~100 lines, 1.5h) ← note extra letter
        - Time: 1.5h (cumulative: 5.5h)
        - Timestamp: 2025-11-09T02:30:51 ← random seconds
        - Files: models/User.js, models/Post.js, db.js (connection)
     
     5-20. Continue with similar commits (total at least 30 hours)...

   - **CRITICAL**: Realistic commit scoping with time tracking
     * Each commit = What a dev can write in 2-3 hours (~100-300 lines)
     * **TOTAL PROJECT TIME: 30-36 hours** (hackathon duration)
     * Use thinking tool to estimate hours for each commit (e.g., 0.5h, 1h, 2h, 3h)
     * Make sure all commits add up to **AT LEAST 30 hours** (up to 36 hours max)
     * If a feature touches multiple files (backend + frontend), update them TOGETHER
     * Don't write entire files at once - add functionality incrementally
     * Break large files (500+ lines) into 3-5 commits minimum
     * Each commit should be a focused, working slice of functionality
   
   - For each feature in order, list:
     * Feature name
     * Estimated hours (must add up to AT LEAST 30 hours total, up to 36 max)
     * EXACT file changes (not entire files, but specific additions)
     * Why it comes at this point
     * Git commit message with random seconds
   
   - **TIME TRACKING EXAMPLE:**
     Use thinking tool first to plan:
     1. "init commit lets gooo" - 0.5 hours (cumulative: 0.5h, timestamp: 21:00:17)
     2. "server setup" - 1 hour (cumulative: 1.5h, timestamp: 22:30:42)
     3. "auth kinda wrking???" - 2.5 hours (cumulative: 4h, timestamp: 01:00:38)
     ... continue until reaching at least 30 hours total (up to 36h)

4. **READ YOUR PLAN BEFORE RECONSTRUCTION**
   - Before creating the new directory, READ AGENT_INFO.md completely
   - Review your feature list and build order
   - Make any final adjustments to the plan in AGENT_INFO.md

5. **RECONSTRUCT THE CODEBASE**
   - Create a new directory: repro_<HASH> in the parent of the given path
   - Use a short hash (first 8 chars of md5 of the original path)
   - Initialize git in this new directory
   - Follow your BUILD ORDER from AGENT_INFO.md exactly:
     
     **CRITICAL RULES FOR EACH COMMIT:**
     a. **Realistic Scope**: Each commit = 2-3 hours of coding
        - Think: "What can a good 17yo dev write in one sitting?"
        - ~100-300 lines of new code per commit (varies by complexity)
        - One focused feature slice, not entire systems
        - Example good scopes:
          * "Basic server setup + one endpoint" (not all endpoints)
          * "Login UI component" (not entire auth system)
          * "Database connection + one model" (not all models)
     
     b. **Incremental Additions**: Don't write entire files at once
        - Example: If server.js needs /login and /users endpoints:
          * Commit 1: Add basic server setup + /login endpoint (~150 lines)
          * Commit 2: Add /users endpoint to existing server.js (~80 lines)
          * NOT: Complete 500-line server.js in one commit!
     
     c. **Cross-Cutting Features**: Group related changes across files
        - Example: Login feature should include:
          * server.js: POST /login endpoint (~50 lines)
          * frontend.js: Login form component (~100 lines)
          * Both in ONE commit (~150 lines total)
        - Keep total changes per commit reasonable for 2-3 hour work session
     
     d. **Preserve ALL Functionality**: The final file MUST match the original exactly
        - Read the original file multiple times if needed
        - Don't summarize or skip any functions, imports, or logic
        - Copy code exactly, including comments, whitespace, error handling
        - Verify: "Does my final version have everything the original has?"
     
     e. **Commit Process with Timestamps**:
        1. Write/append to files for this incremental feature
        2. Calculate commit timestamp:
           - Start time: "2025-11-08T21:00:00" (Nov 8, 2025, 9pm)
           - Add cumulative hours from your time estimates
           - **ADD RANDOM SECONDS** (between 10-59) to make it realistic
           - Format: ISO 8601 string (YYYY-MM-DDTHH:MM:SS)
           - Example calculations:
             * Cumulative 0.5h: 2025-11-08T21:00:00 + 0.5h = 2025-11-08T21:30:23
             * Cumulative 4.5h: 2025-11-08T21:00:00 + 4.5h = 2025-11-09T01:30:47
             * Cumulative 24h: 2025-11-08T21:00:00 + 24h = 2025-11-09T21:00:18
             * Cumulative 36h: 2025-11-08T21:00:00 + 36h = 2025-11-10T09:00:52
        3. Run commit with timestamp environment variables:
           GIT_AUTHOR_DATE="<timestamp>" GIT_COMMITTER_DATE="<timestamp>" git add -A && git commit -m "raw message"
           
           Example full command:
           GIT_AUTHOR_DATE="2025-11-09T01:30:47" GIT_COMMITTER_DATE="2025-11-09T01:30:47" git add -A && git commit -m "auth kinda wrking???"
        4. Move to next incremental feature and update cumulative time
     
     **COMMIT MESSAGE STYLE** - Raw, chaotic, NOT grammatically correct sentences:
     Write commits like a 17yo hackathon participant at 3am would (JUST THE MESSAGE):
     - Excited: "HOLY SHIT THIS WORKS LFGGGGG", "yesss overlay working", "LFG!!!", "IT WORKSSSS", "lessgooooo"
     - Tired: "i can finally slepe", "plz work im so tired", "3am still coding lol", "help", "cant think anymore"
     - Frustrated: "why not working", "this code so dumb omgg", "what am i doing", "bruhh", "whyyy"
     - Casual: "WIP", "init commit", "maybe works???", "yay done", "fixed thing", "update", "stuff", "idk"
     - Progress: "getting somewhere i think", "almost there???", "ok better", "one more"
     - Bugs: "fixed bug lol", "oopss", "my badd", "should work now idk"
     
     **AUTHENTICITY RULES:**
     ⚠️ NO complete sentences - just fragments, thoughts, reactions
     ⚠️ NO "Commit 1:", "Step 1:", numbers, or prefixes
     ⚠️ NO conventional commit format (feat:, fix:, etc)
     ⚠️ KEEP EACH COMMIT SMALL: 2-3 hours of work max (~100-300 lines)
     ⚠️ ADD TYPOS in ~30% of commits: "wroked", "teh", "recieve", double letters ("finallyyy", "omgg")
     ⚠️ NOT grammatically complete: "server working", "auth done", "ui pretty now"
     ⚠️ RANDOM SECONDS in timestamps (10-59) - never :00, :30, etc exactly
     
     **Emotional arc**: Start excited → get tired/frustrated mid-way → relief/hype when features work
     Mix in: typos, missing words, all lowercase, excessive punctuation (!!!, ???), slang (bruh, lfg, fr, ngl)
     Make it AUTHENTIC hackathon energy - raw, unfiltered, chaotic, IMPERFECT!
     
     **QUALITY CHECKS:**
     - Read original files multiple times during reconstruction
     - Don't skip imports, error handling, edge cases, comments
     - The git history should tell a story of how the project evolved
     - If conversation gets long, use the summarize tool to compress previous context
     **Pacing reminder**: More commits = more realistic! Aim for 10-20+ commits, not 3-5 bulk dumps!

6. **FINAL DELIVERABLE & VERIFICATION**
   - A new directory with a git history that simulates the original development
   - Each commit represents one logical, incremental feature slice
   - **MANDATORY**: The final state MUST match the original codebase EXACTLY
     * Same functionality, same imports, same logic
     * No simplified versions or summaries
     * Every function, every edge case, every comment preserved
   - AGENT_INFO.md contains your complete analysis and plan
   
   **FINAL VERIFICATION STEPS:**
   1. For each major file, read the original one more time
   2. Compare: Does my reconstructed file have all the same exports/functions/logic?
   3. If anything is missing, add it in a final "polish" commit
   4. The reconstruction shows HOW it was built, but the END STATE must be identical

## AVAILABLE TOOLS:
- read_file(path): Read file contents
- write_file(path, content): Write/create files
- list_directory(path): List directory contents
- grep(pattern, path, options): Search for patterns in files using ripgrep
- run_command(command, cwd): Execute shell commands
- summarize(text): Compress lengthy text/conversation history when approaching token limits
- thinking(thought): Log your reasoning (use frequently!)

## IMPORTANT:
- **USE AGENT_INFO.md AS YOUR WORKING MEMORY** - Write to it constantly as you discover things
- Create AGENT_INFO.md FIRST before deep exploration
- Update AGENT_INFO.md incrementally - don't wait until the end
- READ AGENT_INFO.md before starting reconstruction to review your plan

**RECONSTRUCTION RULES (NON-NEGOTIABLE):**
- ⚠️ **NO LOSSY COMPRESSION**: Final files MUST contain ALL code from originals
- ⚠️ **INCREMENTAL COMMITS**: Never write entire files in one commit (unless tiny)
- ⚠️ **CROSS-CUTTING FEATURES**: Related changes across multiple files = ONE commit
- ⚠️ **VERIFY COMPLETENESS**: Before final commit, diff your files against originals

**COMMIT STRATEGY:**
- Each commit = ~2-3 hours of work (100-300 lines typically)
- One focused feature slice across all relevant files
- Example: "auth finally works omg" touches backend + frontend together (~150 lines total)
- Build complexity gradually through MANY small commits (10-20+ commits is normal!)
- Think: "What would a tired 17yo hackathon dev add in one coding session?"
- **DON'T**: Dump entire 500+ line files in one commit
- **DO**: Break large features into multiple 2-3 hour chunks
- **DO**: Use thinking tool to plan time estimates (MINIMUM 30h total, up to 36h)
- **DO**: Set GIT_AUTHOR_DATE and GIT_COMMITTER_DATE with random seconds (10-59)
- **Commit messages MUST sound like real hackathon messages** (see examples above!)

**QUALITY CHECKS:**
- Read original files multiple times during reconstruction
- Don't skip imports, error handling, edge cases, comments
- The git history should tell a story of how the project evolved
- If conversation gets long, use the summarize tool to compress previous context`;

      const userPrompt = `Analyze and reconstruct the codebase at: ${projectPath}

Here's the directory structure (tree -L 2):

\`\`\`
${treeOutput || "Tree output not available"}
\`\`\`

BEGIN BY:
1. Creating AGENT_INFO.md in the project root (${projectPath}/AGENT_INFO.md)
2. Writing an initial section with the project path and tree structure
3. Then start exploring systematically, updating AGENT_INFO.md as you discover features
4. BEFORE reconstruction: Use thinking tool to plan time estimates (AT LEAST 30 hours, up to 36h max)
5. Add timestamps with RANDOM SECONDS to your BUILD ORDER in AGENT_INFO.md (start: 2025-11-08T21:00:00)

CRITICAL REMINDERS:
- 📝 AGENT_INFO.md is your notepad - write to it constantly!
- 🔄 Plan INCREMENTAL commits (each = 2-3 hours of coding, ~100-300 lines)
- 🎯 Group related changes across files into single commits
- ✅ Final code MUST match originals EXACTLY (no lossy compression!)
- ⏱️ Realistic pace: Think like a 17yo dev working 2-3 hour coding sessions
- ⏰ **30-36 HOUR HACKATHON**: Use thinking tool to estimate hours (MINIMUM 30 hours total)
- 📅 **TIMESTAMPS**: Start at "2025-11-08T21:00:00", add cumulative hours + RANDOM SECONDS (10-59)

Example commits with time estimates and timestamps (raw fragments, typos!):

BEFORE COMMITTING: Use thinking tool to plan time for each commit - AT LEAST 30 hours total (up to 36h)

Then for each commit with RANDOM SECONDS:
1. "init commit lets gooo" - 0.5h
   Timestamp: "2025-11-08T21:00:17" (start: 9pm Friday + 17 random seconds)
   Command: GIT_AUTHOR_DATE="2025-11-08T21:00:17" GIT_COMMITTER_DATE="2025-11-08T21:00:17" git commit -m "init commit lets gooo"

2. "server setup" - 1h (cumulative: 1.5h)
   Timestamp: "2025-11-08T22:30:42" (0.5h + 1h = 1.5h later + 42 random seconds)
   Command: GIT_AUTHOR_DATE="2025-11-08T22:30:42" GIT_COMMITTER_DATE="2025-11-08T22:30:42" git commit -m "server setup"

3. "auth kinda wrking???" - 2.5h (cumulative: 4h) ← typo
   Timestamp: "2025-11-09T01:00:38" (4 hours after start = 1am Saturday + 38 random seconds)
   Command: GIT_AUTHOR_DATE="2025-11-09T01:00:38" GIT_COMMITTER_DATE="2025-11-09T01:00:38" git commit -m "auth kinda wrking???"

... continue until cumulative time reaches AT LEAST 30 hours (can go up to 36h - ends Sunday 9am)

❌ BAD: "Commit 1: Add authentication feature" (too formal, has numbering!)
❌ BAD: "feat: add user authentication" (conventional commits are NOT hackathon style!)
❌ BAD: One commit with 800 lines across 5 complete files (way too much for 2-3 hours!)
✅ GOOD: "auth working lets goooo" (raw, emotional, quick)
✅ GOOD: ~150 lines in 2-3 files per commit (realistic 2-3 hour work session)

Remember: Raw fragments with typos! Not complete sentences! Add typos/repetition in ~30% of commits!
- "teh" not "the", "wrking" not "working", "finallyyy" not "finally"
- Fragments like "auth done" not "I added authentication"
- Missing words: "ui ugly" not "the ui is ugly"

IMPORTANT: 
- Break work into MANY small commits - more commits = more realistic hackathon history!
- Time estimates must total AT LEAST 30 hours (can go up to 36 hours)
- ALWAYS add random seconds (10-59) to timestamps for realism!`;

      let messages = [{ role: "user", content: userPrompt }];
      let finalResponse = "";

      while (true) {
        const response = await fetch(this.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "tools-2024-04-04",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 64_000,
            system: systemPrompt,
            messages: messages,
            tools: [
              {
                name: "read_file",
                description:
                  "Read the contents of a file at the given absolute path",
                input_schema: {
                  type: "object",
                  properties: {
                    path: {
                      type: "string",
                      description: "Absolute path to the file to read",
                    },
                  },
                  required: ["path"],
                },
              },
              {
                name: "write_file",
                description:
                  "Write or create a file at the given absolute path. Creates parent directories if needed.",
                input_schema: {
                  type: "object",
                  properties: {
                    path: {
                      type: "string",
                      description: "Absolute path to the file to write",
                    },
                    content: {
                      type: "string",
                      description: "Content to write to the file",
                    },
                  },
                  required: ["path", "content"],
                },
              },
              {
                name: "list_directory",
                description: "List all files and directories in the given path",
                input_schema: {
                  type: "object",
                  properties: {
                    path: {
                      type: "string",
                      description: "Absolute path to the directory to list",
                    },
                  },
                  required: ["path"],
                },
              },
              {
                name: "run_command",
                description:
                  "Execute a shell command. Use for git operations and other system commands.",
                input_schema: {
                  type: "object",
                  properties: {
                    command: {
                      type: "string",
                      description: "The shell command to execute",
                    },
                    cwd: {
                      type: "string",
                      description:
                        "The working directory to execute the command in",
                    },
                  },
                  required: ["command", "cwd"],
                },
              },
              {
                name: "grep",
                description:
                  "Search for patterns in files using ripgrep. Fast and efficient for searching through codebases.",
                input_schema: {
                  type: "object",
                  properties: {
                    pattern: {
                      type: "string",
                      description: "The search pattern (regex supported)",
                    },
                    path: {
                      type: "string",
                      description: "The directory or file path to search in",
                    },
                    options: {
                      type: "object",
                      description: "Optional search options",
                      properties: {
                        case_insensitive: {
                          type: "boolean",
                          description: "Perform case-insensitive search",
                        },
                        files_with_matches: {
                          type: "boolean",
                          description: "Only show filenames with matches",
                        },
                        line_numbers: {
                          type: "boolean",
                          description: "Show line numbers (default true)",
                        },
                        context: {
                          type: "integer",
                          description:
                            "Number of context lines to show around matches",
                        },
                      },
                    },
                  },
                  required: ["pattern", "path"],
                },
              },
              {
                name: "summarize",
                description:
                  "Compress and summarize lengthy text or conversation history. Use this when the conversation is getting very long to stay within token limits.",
                input_schema: {
                  type: "object",
                  properties: {
                    text: {
                      type: "string",
                      description:
                        "The text or conversation history to summarize",
                    },
                  },
                  required: ["text"],
                },
              },
              {
                name: "thinking",
                description:
                  "Log your thought process and reasoning. Use this frequently to document your analysis.",
                input_schema: {
                  type: "object",
                  properties: {
                    thought: {
                      type: "string",
                      description: "Your thought or observation",
                    },
                  },
                  required: ["thought"],
                },
              },
            ],
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.log(messages);
          console.error("API Error Response:", errorText);
          throw new Error(
            `HTTP error! status: ${response.status}, body: ${errorText}`
          );
        }

        const data = await response.json();
        let hasToolUse = false;
        const assistantMessage = { role: "assistant", content: [] };
        const toolResults = [];

        for (const content of data.content) {
          assistantMessage.content.push(content);

          if (content.type === "text") {
            finalResponse += content.text;
          } else if (content.type === "tool_use") {
            hasToolUse = true;
            console.log(
              `[TOOL CALL] ${content.name}(${JSON.stringify(
                content.input,
                null,
                2
              )})`
            );
            const toolResult = await this.tool(content.name, content.input);

            toolResults.push({
              type: "tool_result",
              tool_use_id: content.id,
              content: JSON.stringify(toolResult),
            });
          }
        }

        if (hasToolUse) {
          // Push assistant message with all tool uses
          messages.push(assistantMessage);
          // Push user message with all tool results
          messages.push({
            role: "user",
            content: toolResults,
          });
        }

        if (!hasToolUse) {
          break;
        }
      }

      // Cleanup: Delete AGENT_INFO.md after analysis is complete
      const pathModule = await import("path");
      const fs = await import("fs/promises");
      const agentInfoPath = pathModule.join(projectPath, "AGENT_INFO.md");
      try {
        await fs.unlink(agentInfoPath);
        console.log(`\n[CLEANUP] Deleted ${agentInfoPath}`);
      } catch (error) {
        // Ignore if file doesn't exist or can't be deleted
        if (error.code !== "ENOENT") {
          console.warn(
            `[CLEANUP] Could not delete AGENT_INFO.md: ${error.message}`
          );
        }
      }

      return finalResponse;
    } catch (error) {
      throw new Error(`Agent execution failed: ${error}`);
    }
  }
}

export default E2EAgent;

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const agent = new E2EAgent();

  if (process.argv.length < 3) {
    console.log("Usage: node agent.js <absolute-path-to-project>");
    console.log("Example: node agent.js /Users/username/projects/my-app");
    process.exit(1);
  }

  const projectPath = process.argv[2];
  const fs = await import("fs/promises");

  try {
    const stats = await fs.stat(projectPath);
    if (!stats.isDirectory()) {
      console.error("Error: Path must be a directory");
      process.exit(1);
    }
  } catch (error) {
    console.error("Error: Path does not exist or is not accessible");
    process.exit(1);
  }

  console.log(`Starting codebase analysis for: ${projectPath}`);
  console.log("This may take a while...\n");

  agent
    .run(projectPath)
    .then((result) => {
      console.log("\n=== ANALYSIS COMPLETE ===");
      console.log(result);
    })
    .catch((error) => console.error("Error:", error.message));
}
