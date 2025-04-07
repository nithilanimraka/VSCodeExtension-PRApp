/* --- START INLINE JAVASCRIPT --- */
import MarkdownIt from 'markdown-it';

// Define necessary types directly or import from a shared types file
// These might need adjustment based on exactly what properties you use
// Ideally, import from a shared types definition file (e.g., ../types)
interface VsCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}
declare const acquireVsCodeApi: () => VsCodeApi;

// Define basic structures for data received via postMessage
// Import the full types if shared properly
type ReviewComment = { body?: string | null; body_html?: string | null; diff_hunk?: string | null; id: number; user?: { login?: string | null, avatar_url?: string | null } | null; created_at: string; path?: string | null; html_url?: string | null; line?: number | null; start_line?: number | null; pull_request_review_id?: number | null };
type Review = { id: number; state?: string | null; user?: { login?: string | null, avatar_url?: string | null } | null; submitted_at?: string | null; body?: string | null; body_html?: string | null; html_url?: string | null; associated_comments?: ReviewComment[] | null };
type IssueComment = { body?: string | null; body_html?: string | null; id: number; user?: { login?: string | null, avatar_url?: string | null } | null; created_at: string; html_url?: string | null; };
type CommitListItem = { sha: string; commit: { author?: { name?: string | null, date?: string | null } | null, committer?: { date?: string | null } | null, message: string }; author?: { login?: string | null, avatar_url?: string | null } | null; html_url?: string | null };

interface TimelineItemBase { timestamp: Date; } // Keep Date type if possible
interface ReviewTimelineItem extends TimelineItemBase { type: 'review'; data: Review }
interface ReviewCommentTimelineItem extends TimelineItemBase { type: 'review_comment'; data: ReviewComment }
interface IssueCommentTimelineItem extends TimelineItemBase { type: 'issue_comment'; data: IssueComment }
interface CommitTimelineItem extends TimelineItemBase { type: 'commit'; data: CommitListItem }
type TimelineItem = ReviewTimelineItem | ReviewCommentTimelineItem | IssueCommentTimelineItem | CommitTimelineItem;


(function() {
    const vscode = acquireVsCodeApi();
    const timelineContainer = document.getElementById('timeline-area');

    // --- Instantiate Markdown-It ---
    // Ensure markdownit is loaded (check browser console if errors occur)
    // --- Instantiate Markdown-It ---
    const md = MarkdownIt({
        html: false, // Keep false for security
        linkify: true,
        typographer: true,
        breaks: true
    });
    // --- End Instantiate ---

    // --- Helper Functions ---
    function escapeHtml(unsafe: any): string {
        if (typeof unsafe !== 'string') return '';
        return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }

    function formatReviewState(state: string | null | undefined): string {
        switch (state?.toUpperCase()) {
            case 'APPROVED': return 'approved';
            case 'CHANGES_REQUESTED': return 'requested changes';
            case 'COMMENTED': return 'commented';
            case 'DISMISSED': return 'dismissed review';
            default: return state?.toLowerCase() || 'reviewed';
        }
    }

    function generateCommentBodyHtml(comment: { body?: string | null, body_html?: string | null, id: number }): string {
        let commentBodyContent = '';
        if (comment.body_html && comment.body_html.trim() !== '') {
            commentBodyContent = comment.body_html;
        } else if (comment.body && comment.body.trim() !== '') {
            console.log(`Rendering comment.body with markdown-it for comment #${comment.id}`);
            try {
                commentBodyContent = md.render(comment.body);
            } catch (e) {
                console.error(`Markdown rendering failed for comment #${comment.id}:`, e);
                commentBodyContent = `<pre style="white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(comment.body)}</pre>`;
            }
        }
        return commentBodyContent ? `<div class="comment-body">${commentBodyContent}</div>` : '';
    }

    // --- NEW: Helper to generate HTML for a single review comment (used for nesting) ---
    // Simplified version of generateReviewCommentHtml, focusing on the comment itself
    
    function generateNestedReviewCommentHtml(comment: ReviewComment): string {
        const user = comment.user;
        const createdAt = comment.created_at ? new Date(comment.created_at).toLocaleString() : '';
        const commentBody = generateCommentBodyHtml(comment); // Uses helper
    
        let filteredHunkHtml = '';
        const diffHunk = comment.diff_hunk;
        const commentEndLine = (typeof comment.line === 'number') ? comment.line : null;
        const commentStartLine = (typeof comment.start_line === 'number') ? comment.start_line : commentEndLine;
        const isSingleLineComment = (commentStartLine === commentEndLine);
        const CONTEXT_LINES_BEFORE = 3;
    
        if (diffHunk && commentEndLine !== null && commentStartLine !== null) {
            // --- ADD LOGS HERE ---
            console.log(`--- Hunk Details for Comment #${comment.id} ---`);
            console.log(`Target Range: ${commentStartLine} - ${commentEndLine}`);
            console.log(`Raw Diff Hunk Received:\n${diffHunk}`);
            // --- END LOGS ---
            const lines = diffHunk.split('\n'); // Use double backslash for JS string literal
            let styledLinesHtml = '';
            let currentFileLineNum = -1;
            let hunkHeaderFound = false;
            let parseError = false;
            let hunkStartLine = -1;
    
            for (const line of lines) {
                if (parseError) break;
    
                const trimmedLine = line.trim();
                let lineClass = '';
                let displayLineNum = '';
                let fileLineNumForThisLine = -1;
    
                if (trimmedLine.startsWith('@@') && !hunkHeaderFound) {
                    hunkHeaderFound = true;
                    lineClass = 'hunk-header';
                    // Regex uses '\\d' to represent '\d' in the JS regex engine
                    const match = trimmedLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                    if (match && match[1]) {
                        hunkStartLine = parseInt(match[1], 10);
                        currentFileLineNum = hunkStartLine;
                        displayLineNum = '...';
                    } else {
                        console.error(`FAILED to parse hunk header: "${trimmedLine}"`);
                        parseError = true;
                        styledLinesHtml = `<span>Error parsing diff hunk header.</span>`;
                    }
                    continue; // Move to next line after processing header or error
                }
    
                if (!hunkHeaderFound || currentFileLineNum === -1) continue; // Skip lines before valid header
    
                // Determine line type and calculate file line number *for this line*
                if (trimmedLine.startsWith('+')) {
                    lineClass = 'addition';
                    fileLineNumForThisLine = currentFileLineNum;
                    currentFileLineNum++;
                } else if (trimmedLine.startsWith('-')) {
                    lineClass = 'deletion';
                    fileLineNumForThisLine = -1; // No corresponding file line number in the 'new' file
                } else { // Context or empty line
                    lineClass = 'context';
                    if (line.length > 0) { // Only number non-empty context lines
                         fileLineNumForThisLine = currentFileLineNum;
                         currentFileLineNum++;
                    } else {
                         fileLineNumForThisLine = -1; // Don't check empty lines against range
                    }
                }

                // --- Add Detailed Logging Before Filter ---
            let lowerBound = -1; // For debugging log
            if (isSingleLineComment) { lowerBound = Math.max(hunkStartLine, commentEndLine - CONTEXT_LINES_BEFORE); }
            // console.log(
            //     `  Checking Line: fileNum=${fileLineNumForThisLine}, type=${lineClass}, ` +
            //     `targetRange=[${commentStartLine}-${commentEndLine}], single=${isSingleLineComment}, ` +
            //     `hunkStart=${hunkStartLine}, lowerBound=${lowerBound !== -1 ? lowerBound : 'N/A'}`
            // );
            // // --- End Detailed Logging ---
    
                // --- Filter Logic ---
                let keepLine = false;
                // Keep Add(+) or Context( ) lines based on calculated file line number
                if (fileLineNumForThisLine !== -1 && (lineClass === 'addition' || lineClass === 'context')) {
                    if (isSingleLineComment) {
                        // For single lines, show line L and up to CONTEXT_LINES_BEFORE
                        const lowerBound = Math.max(hunkStartLine, commentEndLine - CONTEXT_LINES_BEFORE);
                        if (fileLineNumForThisLine >= lowerBound && fileLineNumForThisLine <= commentEndLine) {
                            keepLine = true;
                        }
                    } else {
                        // For multi-lines, show the exact range S to L
                        if (fileLineNumForThisLine >= commentStartLine && fileLineNumForThisLine <= commentEndLine) {
                            keepLine = true;
                        }
                    }
                }
    
                if (keepLine) {
                    displayLineNum = String(fileLineNumForThisLine);
                    const escapedLine = escapeHtml(line); // Assumes escapeHtml is defined
    
                    // --- **VERIFY THIS LINE IS EXACTLY AS BELOW** ---
                    styledLinesHtml += `<span class="line ${lineClass}">` +
                                           `<span class="line-num">${displayLineNum}</span>` +
                                           `<span class="line-content ${lineClass}">${escapedLine}</span>` +
                                       `</span>`; // No trailing newline
                    // --- **END VERIFY** ---
                }
            } // End for loop
    
            // Wrap the filtered lines in the outer elements
            if (styledLinesHtml && !parseError) {
               filteredHunkHtml = `<div class="diff-hunk"><pre><code>${styledLinesHtml}</code></pre></div>`;
            } else if (parseError) {
                filteredHunkHtml = `<div class="diff-hunk"><pre><code>${styledLinesHtml}</code></pre></div>`; // Contains error message
            }
    
        } // End if(diffHunk...)
    
        // Don't render the whole comment item if there's no body AND no filtered hunk
        if (!commentBody && !filteredHunkHtml) return '';
    
        // Generate line range string
        let lineRangeString = '';
        if (commentStartLine !== null && commentEndLine !== null && commentStartLine !== commentEndLine) {
            lineRangeString = `<span class="line-range"> lines ${commentStartLine} to ${commentEndLine}</span>`;
        } else if (commentEndLine !== null) {
            lineRangeString = `<span class="line-range"> line ${commentEndLine}</span>`;
        }
    
        // Return full comment HTML
        return `<div class="timeline-item nested-review-comment-item" style="margin-left: 20px; margin-top: 10px; border-top: 1px dashed var(--vscode-editorWidget-border, #666); padding-top: 10px;">
                    <div class="item-header" style="font-size: 0.95em;">
                         ${user ? `<img class="avatar" src="${user.avatar_url || ''}" alt="${escapeHtml(user?.login || 'unknown user')}" width="18" height="18">`: '<span class="avatar-placeholder" style="width:18px; height:18px;"></span>'}
                        <strong class="author">${escapeHtml(user?.login || 'unknown user')}</strong> commented on
                        ${comment.path ? `<span class="file-path" style="font-size: 0.9em;">${escapeHtml(comment.path)}</span>` : ''}
                        ${lineRangeString}
                        ${comment.html_url ? `<a class="gh-link" href="${comment.html_url}" title="View comment on GitHub" target="_blank">🔗</a>` : ''}
                        <span class="timestamp" style="font-size: 0.9em;">${createdAt}</span>
                    </div>
                    ${filteredHunkHtml}
                    ${commentBody}
                </div>`;
    }
     

    // --- HTML Generation Functions (REVISED with null checks and correct body_html usage) ---
    function generateReviewHtml(review: Review): string {
        const associatedComments = review.associated_comments || [];
        const stateFormatted = formatReviewState(review.state);
        const stateClass = review.state?.toLowerCase() || 'commented';
        const user = review.user;
        const submittedAt = review.submitted_at ? new Date(review.submitted_at).toLocaleString() : '';
        const reviewBody = generateCommentBodyHtml(review);
        const hasMeaningfulState = review.state && review.state !== 'COMMENTED';

        if (!reviewBody && !hasMeaningfulState && associatedComments.length === 0) {
             console.log(`Skipping review submission #${review.id} as it's empty and has no comments.`);
             return '';
        }

        let commentsHtml = '';
        if (associatedComments.length > 0) {
            commentsHtml = associatedComments.map(comment => generateNestedReviewCommentHtml(comment)).join('');
        }

        return `<div class="timeline-item review-submission-item">
                    <div class="item-header">
                        ${user ? `<img class="avatar" src="${user.avatar_url || ''}" alt="${escapeHtml(user?.login || 'unknown user')}" width="20" height="20">`: '<span class="avatar-placeholder"></span>'}
                        <strong class="author"><span class="math-inline">${escapeHtml(user?.login || 'unknown user')}</strong>
                        <span class="review-state ${stateClass}">${stateFormatted}</span>
                        ${review.html_url ? `<a class="gh-link" href="${review.html_url}" title="View review on GitHub" target="_blank">🔗</a>` : ''}
                        <span class="timestamp"><span class="math-inline">${submittedAt}</span>
                        </div>
                        ${reviewBody}
                        ${commentsHtml}
                    </div>`;
    }

    // Standalone review comment renderer (if any appear unexpectedly)
    function generateReviewCommentHtml(comment: ReviewComment): string {
        const user = comment.user;
        const createdAt = comment.created_at ? new Date(comment.created_at).toLocaleString() : '';
        const diffHunkHtml = (comment.diff_hunk && comment.diff_hunk.trim() !== '') ? `<div class="diff-hunk"><pre><code>${escapeHtml(comment.diff_hunk)}</code></pre></div>` : ''; // Raw hunk here
        const commentBody = generateCommentBodyHtml(comment);

         if (!commentBody && !diffHunkHtml) return '';

                        // Correction: generateReviewCommentHtml shouldn't call generateNestedReviewCommentHtml
                        // It should probably just display its own content without the nested styling/filtering
                        // Or, ideally, it shouldn't be called if filtering in extension.ts is correct.
                        // Let's simplify it for now to just show body:
        return `<div class="timeline-item review-comment-item">
                    <div class="item-header">
                        ${user ? `<img class="avatar" src="${user.avatar_url || ''}" alt="${escapeHtml(user?.login || 'unknown user')}" width="20" height="20">`: '<span class="avatar-placeholder"></span>'}
                        <strong class="author"><span class="math-inline">${escapeHtml(user?.login || 'unknown user')}</strong> commented on
                        ${comment.path ? `<span class="file-path">${escapeHtml(comment.path)}</span>` : ''}
                        ${comment.html_url ? `<a class="gh-link" href="${comment.html_url}" title="View on GitHub" target="_blank">🔗</a>` : ''}
                        <span class="timestamp"><span class="math-inline">${createdAt}</span>
                    </div>
                    ${commentBody} 
                </div>`;
    }      

     // Issue comment renderer
    function generateIssueCommentHtml(comment: IssueComment): string {
        const user = comment.user;
        const createdAt = comment.created_at ? new Date(comment.created_at).toLocaleString() : '';
        const commentBody = generateCommentBodyHtml(comment);

        if (!commentBody) return '';

        return `<div class="timeline-item issue-comment-item">
                    <div class="item-header">
                        ${user ? `<img class="avatar" src="${user.avatar_url || ''}" alt="${escapeHtml(user?.login || 'unknown user')}" width="20" height="20">`: '<span class="avatar-placeholder"></span>'}
                        <strong class="author"><span class="math-inline">${escapeHtml(user?.login || 'unknown user')}</strong> commented
                        ${comment.html_url ? `<a class="gh-link" href="${comment.html_url}" title="View on GitHub" target="_blank">🔗</a>` : ''}
                        <span class="timestamp"><span class="math-inline">${createdAt}</span>
                    </div>
                    ${commentBody}
                </div>`;
    }

    // Commit renderer
    function generateCommitHtml(commitData: CommitListItem): string {
        const authorInfo = commitData.commit.author;
        const committerInfo = commitData.commit.committer;
        const userAuthor = commitData.author;
        const commitShaShort = commitData.sha.substring(0, 7);
        const avatarUrl = userAuthor?.avatar_url || '';
        const authorName = escapeHtml(authorInfo?.name || userAuthor?.login || 'unknown');
        const commitDate = authorInfo?.date ? new Date(authorInfo.date).toLocaleString() : (committerInfo?.date ? new Date(committerInfo.date).toLocaleString() : '');
        const commitMessage = escapeHtml(commitData.commit.message.split('\n')[0]);
        const commitUrl = commitData.html_url || '';

        return `<div class="timeline-item commit-item">
                   <div class="item-header">
                        ${avatarUrl ? `<img class="avatar" src="${avatarUrl}" alt="${authorName}" width="20" height="20">` : '<span class="avatar-placeholder"></span>'}
                        <span class="author"><span class="math-inline">${authorName}</span> committed
                        ${commitUrl ? `<a href="${commitUrl}" target="_blank"><code>${commitShaShort}</code></a>` : `<code>${commitShaShort}</code>`}
                        <span class="timestamp"><span class="math-inline">${commitDate}</span>
                        </div>
                        <div class="comment-body commit-message" title="${escapeHtml(commitData.commit.message)}">${commitMessage}</div>
                </div>`;
}


    // --- Main Rendering Function ---
    function renderTimeline(timelineData: TimelineItem[]) {
        if (!timelineContainer) { console.error("Timeline container not found!"); return; }
        timelineContainer.innerHTML = ''; // Clear previous content ('Loading...' indicator)

        if (!timelineData || timelineData.length === 0) {
            timelineContainer.innerHTML = '<p>No timeline activity found for this pull request.</p>';
            return;
        }

         console.log(`Rendering ${timelineData.length} timeline items...`);
         const fragment = document.createDocumentFragment();
        timelineData.forEach((item: TimelineItem, index: number) => { // Add types here
            let elementHtml = '';
            try {
                // Pass the correctly typed data object
                switch (item.type) {
                    case 'review': elementHtml = generateReviewHtml(item.data); break;
                    case 'review_comment': elementHtml = generateReviewCommentHtml(item.data); break; // Should rarely be hit if filter works
                    case 'issue_comment': elementHtml = generateIssueCommentHtml(item.data); break;
                    case 'commit': elementHtml = generateCommitHtml(item.data); break;
                    default: console.warn("Unknown timeline item type:", (<any>item).type); // Use any type assertion for safety
                }
            } catch (e) {
                 console.error(`Error generating HTML for item index ${index}:`, item, e);
                 elementHtml = `<div class="timeline-item error-item">Error rendering item. See Webview DevTools console.</div>`;
            }

            if (elementHtml) {
                const template = document.createElement('template');
                template.innerHTML = elementHtml.trim();
                 if (template.content.firstChild) {
                     fragment.appendChild(template.content.firstChild);
                 } else {
                      // Only log if we expected content (elementHtml wasn't intentionally empty)
                      if (elementHtml.trim().length > 0) {
                           console.warn(`Generated empty/invalid HTML for item index ${index}:`, item);
                      }
                 }
            }
        });
        timelineContainer.appendChild(fragment);
         // No longer need parseAndStyleDiffHunks here
         console.log("Timeline rendering complete.");
    }

    // --- Message Listener ---
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'updateTimeline':
                console.log('Received timeline update from extension:', message.timeline);
                renderTimeline(message.timeline);
                break;
            case 'loadTimeline': // Handle initial load
                console.log('Received initial timeline data from extension:', message.data);
                renderTimeline(message.data);
                 // Optional: Hide a dedicated loading indicator if you added one
                 // const loadingIndicator = document.getElementById('loading-indicator');
                 // if (loadingIndicator) { loadingIndicator.style.display = 'none'; }
                break;
        }
    });

    // Signal readiness to extension host
    vscode.postMessage({ command: 'webviewReady' });
    console.log("Webview script initialized and ready.");

}()); // End IIFE