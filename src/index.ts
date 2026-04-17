import type { Plugin } from "@opencode-ai/plugin";

export const GitAutocommitPlugin: Plugin = async (ctx) => {
  ctx.client.app.log({ body: { service: "git-autocommit", level: "info", message: "Plugin initialized" } });

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      ctx.client.app.log({ body: { service: "git-autocommit", level: "debug", message: "Session idle detected" } });

      try {
        const cwd = ctx.worktree;

        // Check if .git exists, if not initialize silently
        const gitCheck = await ctx.$`test -d ${cwd}/.git`.quiet();
        if (gitCheck.exitCode !== 0) {
          await ctx.$`git init ${cwd}`.quiet();
          ctx.client.app.log({ body: { service: "git-autocommit", level: "info", message: "Initialized git repository" } });
        }

        // Check for changes
        const statusResult = await ctx.$`git -C ${cwd} status --porcelain`.quiet();
        if (!statusResult.stdout.toString().trim()) {
          ctx.client.app.log({ body: { service: "git-autocommit", level: "debug", message: "No changes detected" } });
          return;
        }

        // Fetch session messages to get last assistant message
        const sessionID = event.properties.sessionID;
        const messagesResponse = await ctx.client.session.messages({
          path: { id: sessionID },
          query: { directory: ctx.directory }
        });

        const messages = messagesResponse.data || [];
        const lastAssistantMsg = [...messages].reverse().find(m => m.info.role === "assistant");

        let commitText = "automated update";
        if (lastAssistantMsg) {
          const textPart = lastAssistantMsg.parts.find(p => p.type === "text");
          if (textPart && "text" in textPart) {
            const rawText = textPart.text
              .split('\n')[0]
              .replace(/[^a-zA-Z0-9 ]/g, "")
              .substring(0, 50)
              .trim();
            if (rawText) commitText = rawText;
          }
        }

        const commitType = commitText.toLowerCase().includes("fix") ? "fix" : "feat";
        const finalMsg = `${commitType}: ${commitText}`;

        // Stage and commit (git respects .gitignore by default)
        await ctx.$`git -C ${cwd} add .`.quiet();
        await ctx.$`git -C ${cwd} commit -m ${finalMsg} --no-verify`.quiet();

        ctx.client.app.log({ body: { service: "git-autocommit", level: "info", message: `Committed: ${finalMsg}` } });

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        ctx.client.app.log({ body: { service: "git-autocommit", level: "error", message: errorMsg } });
      }
    }
  };
};

export default GitAutocommitPlugin;