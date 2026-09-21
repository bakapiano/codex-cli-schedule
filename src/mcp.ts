import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { call, ensureDaemon } from './client.js';
import { operations } from './operations.js';
import { errorMessage } from './model.js';

export async function runMcp(dir: string): Promise<void> {
  await ensureDaemon(dir);
  const server = new McpServer({ name: 'codex-cli-schedule', version: '0.1.0' });
  for (const operation of operations) {
    server.registerTool(operation.name, {
      description: operation.description,
      inputSchema: operation.schema,
      annotations: { readOnlyHint: operation.readOnly, destructiveHint: operation.name === 'schedule_delete', openWorldHint: !operation.readOnly },
    }, async (args: any) => {
      try {
        const result = await call(dir, operation.name, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { result } };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: errorMessage(error) }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}
