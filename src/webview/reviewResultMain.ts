import type { ReviewItemData, ToReviewResultWebviewMessage, VsCodeApi } from '../types'; // Import types

declare const acquireVsCodeApi: () => VsCodeApi;
declare const hljs: any; // Declare highlight.js library if loaded globally via CDN

(function () {
    const vscode = acquireVsCodeApi();
    const reviewListContainer = document.getElementById('review-list-container');
    const exportMdButton = document.getElementById('export-md-button');
    
    if (exportMdButton) {
        exportMdButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'exportMarkdown' });
        });
    }
    // --- Helper Functions ---
    function escapeHtml(unsafe: unknown): string {
        if (typeof unsafe !== 'string') {
            return '';
        }
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // --- Helper to parse line prefix ---
    function parseLinePrefix(prefix: string | undefined | null): { num: number; sign: '+' | '-' | ' ' } {
        if (!prefix) {
            return { num: 0, sign: ' ' };
        }
        const sign = prefix.startsWith('+') ? '+' : prefix.startsWith('-') ? '-' : ' ';
        const numStr = prefix.replace(/^[+-]/, '').trim();
        const num = parseInt(numStr, 10);
        return { num: isNaN(num) ? 0 : num, sign };
    }

    // --- Renders a single review item ---
    function renderReviewItem(review: ReviewItemData): HTMLDivElement {
        const itemDiv = document.createElement('div');
        itemDiv.classList.add('review-item', `severity-${review.severity?.toLowerCase() || 'info'}`);

        // --- File Header ---
        const fileHeader = document.createElement('div');
        fileHeader.className = 'review-file-header';
        const startLineInfo = parseLinePrefix(review.start_line_with_prefix);
        const endLineInfo = parseLinePrefix(review.end_line_with_prefix);
        const lineRangeStr = startLineInfo.num === endLineInfo.num
                           ? `${startLineInfo.sign}${startLineInfo.num}`
                           : `${startLineInfo.sign}${startLineInfo.num} to ${endLineInfo.sign}${endLineInfo.num}`;
        fileHeader.textContent = `${review.fileName || 'Unknown File'} (Lines: ${lineRangeStr})`;
        itemDiv.appendChild(fileHeader);

        // --- Code Segment (Original/Problematic Code) ---
        if (review.codeSegmentToFix) {
            const codeSegmentDiv = document.createElement('div');
            codeSegmentDiv.className = 'review-code-segment';
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.classList.add(`language-${review.language || 'plaintext'}`);

            const lines = review.codeSegmentToFix.split('\n');
            // Use the START number from the parsed prefix for the initial line number
            let currentLineNum = parseLinePrefix(review.start_line_with_prefix).num;

            lines.forEach((line) => {
                const lineDiv = document.createElement('div');
                lineDiv.className = 'code-line';

                const numSpan = document.createElement('span');
                numSpan.className = 'line-num';

                const contentSpan = document.createElement('span');
                contentSpan.className = 'line-content';

                // Determine line type and assign correct number
                const trimmedLine = line.trimStart();
                if (trimmedLine.startsWith('+')) {
                    lineDiv.classList.add('line-added');
                    numSpan.textContent = String(currentLineNum);
                    contentSpan.textContent = line; // Keep prefix
                    currentLineNum++; // Increment for next added/context line
                } else if (trimmedLine.startsWith('-')) {
                    lineDiv.classList.add('line-removed');

                    numSpan.textContent = String(currentLineNum); 
                    contentSpan.textContent = line; // Keep prefix
                } else {
                    lineDiv.classList.add('line-context');
                    numSpan.textContent = String(currentLineNum);
                    contentSpan.textContent = line; // Keep space prefix
                    currentLineNum++; // Increment for next added/context line
                }

                lineDiv.appendChild(numSpan);
                lineDiv.appendChild(contentSpan);
                code.appendChild(lineDiv);
            });

            pre.appendChild(code);
            codeSegmentDiv.appendChild(pre);
            itemDiv.appendChild(codeSegmentDiv);
        }

        
        const analysisBox = document.createElement('div');
        analysisBox.className = 'review-analysis';
        const issueP = document.createElement('p');
        issueP.innerHTML = `<strong>Issue:</strong> ${escapeHtml(review.issue)}`;
        analysisBox.appendChild(issueP);
        const severityP = document.createElement('p');
        severityP.innerHTML = `<strong>Severity:</strong> ${escapeHtml(review.severity)}`;
        analysisBox.appendChild(severityP);
        const suggestionP = document.createElement('p');
        suggestionP.innerHTML = `<strong>Suggestion:</strong> ${escapeHtml(review.suggestion)}`;
        analysisBox.appendChild(suggestionP);

        
        if (review.suggestedCode) {
            const suggestedCodeDiv = document.createElement('div');
            suggestedCodeDiv.className = 'review-suggested-code';
            const heading = document.createElement('strong');
            heading.textContent = 'Suggested Code:';
            suggestedCodeDiv.appendChild(heading);
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.className = `language-${review.language || 'plaintext'}`;
            code.textContent = review.suggestedCode;
            pre.appendChild(code);
            suggestedCodeDiv.appendChild(pre);
            const copyButton = document.createElement('button');
            copyButton.className = 'copy-button';
            copyButton.innerHTML = `<span class="codicon codicon-copy"></span> Copy`;
            copyButton.title = 'Copy code suggestion';
            copyButton.type = 'button';
            copyButton.addEventListener('click', () => {
                if (review.suggestedCode) {
                    navigator.clipboard.writeText(review.suggestedCode)
                        .then(() => {
                            copyButton.textContent = 'Copied!';
                            setTimeout(() => { copyButton.innerHTML = `<span class="codicon codicon-copy"></span> Copy`; }, 1500);
                        })
                        .catch(err => {
                             console.error('Failed to copy code: ', err);
                             copyButton.textContent = 'Error';
                              setTimeout(() => { copyButton.innerHTML = `<span class="codicon codicon-copy"></span> Copy`; }, 1500);
                        });
                }
            });
            suggestedCodeDiv.appendChild(copyButton);
            analysisBox.appendChild(suggestedCodeDiv);
        }

        itemDiv.appendChild(analysisBox);
        return itemDiv;
    }

    // --- Message Listener ---
    window.addEventListener('message', (event: MessageEvent<ToReviewResultWebviewMessage>) => {
        const message = event.data;
        switch (message.command) {
            case 'showReviewResults':
                if (reviewListContainer) {
                    reviewListContainer.innerHTML = '';
                    const reviewData = message.data;
                    if (!Array.isArray(reviewData) || reviewData.length === 0) {
                        reviewListContainer.innerHTML = '<p>No review comments generated, or analysis found no issues.</p>';
                        return;
                    }
                    const fragment = document.createDocumentFragment();
                    reviewData.forEach((review: ReviewItemData) => {
                        fragment.appendChild(renderReviewItem(review));
                    });
                    reviewListContainer.appendChild(fragment);
                    if (typeof hljs !== 'undefined') {
                       try {
                            reviewListContainer.querySelectorAll('.review-suggested-code pre code').forEach((block) => {
                                hljs.highlightElement(block as HTMLElement);
                            });
                       } catch (e) {
                           console.error("Highlight.js error:", e);
                       }
                    } else {
                         console.warn("highlight.js (hljs) not found. Skipping syntax highlighting.");
                    }
                } else {
                    console.error("Could not find review list container element.");
                }
                break;
        }
    });

    // --- Signal Readiness ---
    if (reviewListContainer) {
        vscode.postMessage({ command: 'webviewReady' });
        console.log("Review Results webview script initialized.");
    } else {
         console.error("Review list container not found on initial load.");
    }

}());