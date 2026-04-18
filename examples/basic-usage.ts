import Anthropic from '@anthropic-ai/sdk';
import { Focal } from '@focal/core';

const anthropic = new Anthropic();

const context = await Focal.build({
  repoPath: './my-project',
  query: 'Fix auth token validation bug',
  tokenBudget: 6000,
});

console.log(`Included ${context.files.length} files in ${context.tokensUsed} tokens`);
console.log(context.summary);

// Pass to Claude
const response = await anthropic.messages.create({
  model: 'claude-opus-4-6',
  max_tokens: 2048,
  messages: [
    {
      role: 'user',
      content:
        context.files.map((f) => `// ${f.path}\n${f.content}`).join('\n\n') +
        `\n\nTask: ${context.query}`,
    },
  ],
});

console.log(response.content[0]);
