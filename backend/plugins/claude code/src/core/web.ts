import type { Tool } from '../types/index.js';

export function createWebTools(): Tool[] {
  return [
    {
      name: 'web_fetch',
      description: 'Fetch content from a URL (HTML, text, or JSON)',
      parameters: {
        url: {
          type: 'string',
          description: 'URL to fetch',
          required: true,
        },
        format: {
          type: 'string',
          description: 'Response format: text, html, json, markdown',
          required: false,
          enum: ['text', 'html', 'json', 'markdown'],
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (default: 10000)',
          required: false,
        },
      },
      async execute(args) {
        const url = args.url as string;
        const format = (args.format as string) || 'text';
        const maxChars = (args.max_chars as number) || 10000;

        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'SpearCode/0.1.0',
              Accept: format === 'json' ? 'application/json' : 'text/html,text/plain,*/*',
            },
            signal: AbortSignal.timeout(15000),
          });

          if (!res.ok) {
            return `HTTP ${res.status}: ${res.statusText}`;
          }

          let content: string;

          if (format === 'json') {
            const json = await res.json();
            content = JSON.stringify(json, null, 2);
          } else {
            content = await res.text();

            // Basic HTML to text conversion
            if (format === 'markdown' || (res.headers.get('content-type')?.includes('html') && format !== 'html')) {
              content = htmlToText(content);
            }
          }

          if (content.length > maxChars) {
            content = content.slice(0, maxChars) + '\n\n[...truncated]';
          }

          return content;
        } catch (err) {
          return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'web_search',
      description: 'Search the web using a search engine',
      parameters: {
        query: {
          type: 'string',
          description: 'Search query',
          required: true,
        },
        num_results: {
          type: 'number',
          description: 'Number of results to return (default: 5)',
          required: false,
        },
      },
      async execute(args) {
        const query = args.query as string;
        const numResults = (args.num_results as number) || 5;

        // Use DuckDuckGo instant answers API
        try {
          const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
          const res = await fetch(url, {
            headers: { 'User-Agent': 'SpearCode/0.1.0' },
            signal: AbortSignal.timeout(10000),
          });

          if (!res.ok) {
            return `Search failed: HTTP ${res.status}`;
          }

          const data = await res.json() as {
            Abstract?: string;
            AbstractText?: string;
            AbstractURL?: string;
            RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
            Answer?: string;
            AnswerType?: string;
          };

          const results: string[] = [];

          if (data.AbstractText) {
            results.push(`📝 ${data.AbstractText}\n   ${data.AbstractURL || ''}`);
          }

          if (data.Answer) {
            results.push(`💡 ${data.Answer}`);
          }

          if (data.RelatedTopics) {
            for (const topic of data.RelatedTopics.slice(0, numResults)) {
              if (topic.Text) {
                results.push(`• ${topic.Text}\n  ${topic.FirstURL || ''}`);
              }
            }
          }

          return results.slice(0, numResults).join('\n\n') || `No results found for: ${query}`;
        } catch (err) {
          return `Search error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

function htmlToText(html: string): string {
  return html
    // Remove scripts and styles
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}
