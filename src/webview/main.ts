import MarkdownIt from 'markdown-it';

interface VsCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}
declare const acquireVsCodeApi: () => VsCodeApi;


// Basic structures for data received via postMessage
type ReviewComment = { body?: string | null; body_html?: string | null; diff_hunk?: string | null; id: number; user?: { login?: string | null, avatar_url?: string | null } | null; created_at: string; path?: string | null; html_url?: string | null; line?: number | null; start_line?: number | null; pull_request_review_id?: number | null };
type Review = { id: number; state?: string | null; user?: { login?: string | null, avatar_url?: string | null } | null; submitted_at?: string | null; body?: string | null; body_html?: string | null; html_url?: string | null; associated_comments?: ReviewComment[] | null };
type IssueComment = { body?: string | null; body_html?: string | null; id: number; user?: { login?: string | null, avatar_url?: string | null } | null; created_at: string; html_url?: string | null; };
type CommitListItem = { sha: string; commit: { author?: { name?: string | null, date?: string | null } | null, committer?: { date?: string | null } | null, message: string }; author?: { login?: string | null, avatar_url?: string | null } | null; html_url?: string | null };

interface TimelineItemBase { timestamp: Date; } 
interface ReviewTimelineItem extends TimelineItemBase { type: 'review'; data: Review }
interface ReviewCommentTimelineItem extends TimelineItemBase { type: 'review_comment'; data: ReviewComment }
interface IssueCommentTimelineItem extends TimelineItemBase { type: 'issue_comment'; data: IssueComment }
interface CommitTimelineItem extends TimelineItemBase { type: 'commit'; data: CommitListItem }

type TimelineItem = ReviewTimelineItem | ReviewCommentTimelineItem | IssueCommentTimelineItem | CommitTimelineItem;

interface PrDetails {
    timeline: TimelineItem[];
    mergeable_state: string;
    mergeable: boolean | null;
    state: 'open' | 'closed';
    merged: boolean;
    authorLogin: string;
    authorAvatarUrl?: string | null;
    baseLabel: string;
    headLabel: string;
    body: string | null; 
    createdAt: string; 
}

type MergeStatusUpdateData = {
    mergeable: boolean | null;
    mergeable_state: string;
};

type FromExtensionMessage =
    | { command: 'loadDetails'; data: PrDetails }
    | { command: 'updateTimeline'; timeline: TimelineItem[] } // If polling only sends timeline
    | { command: 'updateMergeStatus'; data: MergeStatusUpdateData }
    | { command: 'showError'; message: string };


(function() {
    const vscode = acquireVsCodeApi();
    const timelineContainer = document.getElementById('timeline-area');

    const mergeStatusDiv = document.getElementById('merge-status');

    const metadataHeaderDiv = document.getElementById('pr-metadata-header');

    const mergeMethodSelect = document.getElementById('merge-method-select') as HTMLSelectElement | null;
    const confirmMergeButton = document.getElementById('confirm-merge-button') as HTMLButtonElement | null; 

    const descriptionAreaDiv = document.getElementById('pr-description-area');

    const commentTextArea = document.getElementById('new-comment-text') as HTMLTextAreaElement | null;
    const addCommentButton = document.getElementById('add-comment-button') as HTMLButtonElement | null;
    const closeButton = document.getElementById('close-button') as HTMLButtonElement | null;
    const refreshButton = document.getElementById('refresh-button') as HTMLButtonElement | null;

    // Instantiate Markdown-It
    const md = MarkdownIt({
        html: false, 
        linkify: true,
        typographer: true,
        breaks: true
    });

    // Helper Functions 

    function renderMetadataHeader(prData: PrDetails) {
        if (!metadataHeaderDiv) return;

        let statusText = 'Unknown';
        let statusClass = 'status-unknown';
        let statusIcon = 'codicon-git-pull-request'; // Default icon

        if (prData.state === 'closed') {
            if (prData.merged) {
                statusText = 'Merged';
                statusClass = 'status-merged';
                statusIcon = 'codicon-git-merge';
            } else {
                statusText = 'Closed';
                statusClass = 'status-closed';
                statusIcon = 'codicon-git-pull-request-closed';
            }
        } else if (prData.state === 'open') {
            statusText = 'Open';
            statusClass = 'status-open';
            statusIcon = 'codicon-git-pull-request'; // Or Draft icon if available/needed
        }

        const authorAvatarHtml = prData.authorAvatarUrl
            ? `<img class="avatar author-avatar" src="${escapeHtml(prData.authorAvatarUrl)}" alt="${escapeHtml(prData.authorLogin)}" width="20" height="20">`
            : '<span class="avatar-placeholder" style="width:20px; height:20px;"></span>'; 

        // Construct the description string
        const descriptionHtml = `
            ${authorAvatarHtml}
            <span class="author-login">${escapeHtml(prData.authorLogin)}</span> wants to merge changes into
            <code class="branch-label">${escapeHtml(prData.baseLabel)}</code> from
            <code class="branch-label">${escapeHtml(prData.headLabel)}</code>
        `;

        metadataHeaderDiv.innerHTML = `
            <span class="pr-status-badge ${statusClass}">
                <span class="codicon ${statusIcon}"></span> ${statusText}
            </span>
            <span class="pr-description-text">
                ${descriptionHtml}
            </span>
        `;
    }

    function renderMergeStatus(mergeable: boolean | null, state: string) {
        if (!mergeStatusDiv) return;
        mergeStatusDiv.classList.remove('loading');
        mergeStatusDiv.innerHTML = ''; 

        let iconClass = 'codicon-question';
        let text = `Merge status: ${state}`;
        let statusClass = 'merge-unknown';

        if (mergeable === true && state === 'clean') {
            iconClass = 'codicon-check';
            text = 'No conflicts with the base branch.';
            statusClass = 'merge-clean';
        } else if (mergeable === false && state === 'dirty') {
             iconClass = 'codicon-warning';
             text = 'Conflicts must be resolved before merging.';
             statusClass = 'merge-dirty';
        } else if (state === 'blocked') {
             iconClass = 'codicon-error';
             text = 'Merging is blocked (e.g., required reviews missing).';
             statusClass = 'merge-blocked';
        } else if (state === 'unstable' || state === 'behind') {
            iconClass = 'codicon-issues'; 
            text = `Merging may be possible, but the branch is ${state}. Consider updating.`;
            statusClass = 'merge-unstable';
        } else {
             text = `Merge status: ${state || 'unknown'}. Mergeability ${mergeable === null ? 'unknown' : mergeable ? 'ok' : 'no'}.`;
        }

        mergeStatusDiv.className = `status-section ${statusClass}`;
        mergeStatusDiv.innerHTML = `<span class="codicon ${iconClass}"></span> ${escapeHtml(text)}`;

        // Enable/Disable Merge button based on state
        if (confirmMergeButton) {
            const canMerge = mergeable === true && ['clean', 'behind', 'unstable'].includes(state);
            confirmMergeButton.disabled = !canMerge;
            confirmMergeButton.title = canMerge ? 'Confirm merging this pull request' : `Cannot merge (State: ${state}, Mergeable: ${mergeable})`;
        }
    }

    // Render Function for PR Description 
    function renderPrDescription(prData: PrDetails) {
        if (!descriptionAreaDiv) return;

        const createdAtDate = new Date(prData.createdAt);
        const formattedDate = createdAtDate.toLocaleString(); // Format date nicely

        const authorAvatarHtml = prData.authorAvatarUrl
            ? `<img class="avatar author-avatar" src="${escapeHtml(prData.authorAvatarUrl)}" alt="${escapeHtml(prData.authorLogin)}" width="20" height="20">`
            : '<span class="avatar-placeholder" style="width:20px; height:20px;"></span>';

        const headerHtml = `
            <div class="comment-header"> 
                ${authorAvatarHtml}
                <strong class="author">${escapeHtml(prData.authorLogin)}</strong> commented on ${formattedDate}
            </div>
        `;

        let bodyHtml = '';
        if (prData.body && prData.body.trim() !== '') {
            try {
                 // Use markdown-it to render the body
                 bodyHtml = `<div class="pr-body-content markdown-body">${md.render(prData.body)}</div>`;
            } catch (e) {
                 console.error("Markdown rendering failed for PR body:", e);
                  // Fallback to preformatted text on error
                 bodyHtml = `<div class="pr-body-content"><pre>${escapeHtml(prData.body)}</pre></div>`;
            }
        } else {
            bodyHtml = `<p class="no-description"><em>No description provided.</em></p>`;
        }

        // Combine header and body
        descriptionAreaDiv.innerHTML = headerHtml + bodyHtml;
        descriptionAreaDiv.classList.remove('loading'); // Remove loading state if applicable
    }

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
            try {
                commentBodyContent = md.render(comment.body);
            } catch (e) {
                console.error(`Markdown rendering failed for comment #${comment.id}:`, e);
                commentBodyContent = `<pre style="white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(comment.body)}</pre>`;
            }
        }
        return commentBodyContent ? `<div class="comment-body">${commentBodyContent}</div>` : '';
    }

    function generateNestedReviewCommentHtml(comment: ReviewComment): string {
        const user = comment.user;
        const createdAt = comment.created_at ? new Date(comment.created_at).toLocaleString() : '';
        const commentBody = generateCommentBodyHtml(comment); 
    
        let filteredHunkHtml = '';
        const diffHunk = comment.diff_hunk;
        const commentEndLine = (typeof comment.line === 'number') ? comment.line : null;
        const commentStartLine = (typeof comment.start_line === 'number') ? comment.start_line : commentEndLine;
        const isSingleLineComment = (commentStartLine === commentEndLine);
        const PRECEDING_CONTEXT_LINES = 3; 
        
        if (diffHunk && commentEndLine !== null && commentStartLine !== null) {
            const lines = diffHunk.split('\n');
    
  
            // This determines if the line numbers [start..end] refer to OLD (-) or NEW (+) file lines
            let commentTargetsDeletion = false;
            try {
                let tempOldLineNum = -1;
                let inHunk = false;
                let deletionFoundInRange = false;
                const tempLines = diffHunk.split('\n'); 
    
                for (const line of lines) {
                    if (line.startsWith('@@')) {
                        const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
                        if (match && match[1]) {
                            tempOldLineNum = parseInt(match[1], 10);
                            inHunk = true;
                        } else {
                            inHunk = false;
                        }
                        continue;
                    }
                    if (inHunk && tempOldLineNum !== -1) {
                        if (line.startsWith('-')) {
                            if (tempOldLineNum >= commentStartLine && tempOldLineNum <= commentEndLine) {
                                 deletionFoundInRange = true;
                                 break; // Found one, context determined
                            }
                            tempOldLineNum++;
                        } else if (line.startsWith('+')) {
                             // Doesn't increment old line number
                        } else if (line.startsWith(' ')) {
                             tempOldLineNum++;
                        }
                    }
                }
                commentTargetsDeletion = deletionFoundInRange;
                console.log(`Hunk Pre-analysis V2: commentTargetsDeletion = ${commentTargetsDeletion} for target [${commentStartLine}-${commentEndLine}]`);
            } catch (e) {
                console.error("Error during hunk pre-analysis V2:", e);
                commentTargetsDeletion = false;
            }
    
            const linesToRender = diffHunk.split('\n');

            if (linesToRender.length > 0 && linesToRender[linesToRender.length - 1] === '') {
                linesToRender.pop();
            }
    
            let styledLinesHtml = '';
            let parseError = false;
            let currentOldLineNum = -1;
            let currentNewLineNum = -1;
            let hunkHeaderParsed = false; 
    
            for (const line of linesToRender) {
                if (parseError) break;
   
                let lineClass = '';
                let displayOldLineNum = '';
                let displayNewLineNum = '';
                let lineContent = '';
                let oldLineNumForThis = -1;
                let newLineNumForThis = -1;
                let isHunkHeader = false; 
   
                if (line.startsWith('@@')) {
                    isHunkHeader = true;
                    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
                    if (match && match[1] && match[3]) {
                        // Initialize counters based on the STARTING line numbers from the header
                        currentOldLineNum = parseInt(match[1], 10);
                        currentNewLineNum = parseInt(match[3], 10);
                        hunkHeaderParsed = true; 
                        console.log(`Hunk Header Parsed: Old Start=${currentOldLineNum}, New Start=${currentNewLineNum}`);
                    } else {
                        parseError = true; console.error(`Error parsing hunk header: ${escapeHtml(line)}`);
                    }
                    // DO NOT RENDER HEADER - Skip to next iteration
                    continue;
                }
   
                // Only process lines AFTER a header has been successfully parsed
                if (!hunkHeaderParsed) continue;
   
                // Calculate line numbers and classes for CONTENT lines 
                if (line.startsWith('+')) {
                    lineClass = 'addition'; lineContent = line.substring(1);
                    // Assign the CURRENT counter value, THEN increment for the NEXT line
                    newLineNumForThis = currentNewLineNum; displayNewLineNum = String(newLineNumForThis);
                    currentNewLineNum++;
                } else if (line.startsWith('-')) {
                    lineClass = 'deletion'; lineContent = line.substring(1);
                    oldLineNumForThis = currentOldLineNum; displayOldLineNum = String(oldLineNumForThis);
                    currentOldLineNum++;
                } else if (line.startsWith(' ')) {
                    lineClass = 'context'; lineContent = line.substring(1);
                    oldLineNumForThis = currentOldLineNum; displayOldLineNum = String(oldLineNumForThis);
                    newLineNumForThis = currentNewLineNum; displayNewLineNum = String(newLineNumForThis);
                    currentOldLineNum++;
                    currentNewLineNum++;
                }else if (line.startsWith('~')) { 
                    lineClass = 'context'; 
                    lineContent = line.substring(1); 
                    oldLineNumForThis = currentOldLineNum; displayOldLineNum = String(oldLineNumForThis);
                    newLineNumForThis = currentNewLineNum; displayNewLineNum = String(newLineNumForThis);
                    currentOldLineNum++;
                    currentNewLineNum++;
                }
                else if (line.startsWith('\\')) {
                    // Skip rendering the "no newline" marker
                    continue;
                } else {
                     console.warn("Skipping unexpected line format:", JSON.stringify(line));
                     continue; 
                }
                // --- End Calculate ---
   
   
               // Filtering Logic 
               let keepLine = false;
               const targetStart = commentStartLine;
               const targetEnd = commentEndLine;
               const checkLineNum = commentTargetsDeletion ? oldLineNumForThis : newLineNumForThis;
   
                if (checkLineNum !== -1) { // Only filter if we have a valid line number
                    if (isSingleLineComment) {
                        // Single-line comment: Keep target line and PRECEDING_CONTEXT_LINES before it
                        const displayStart = Math.max(1, targetEnd - PRECEDING_CONTEXT_LINES); // Lower bound is target - N (or 1)
                        const displayEnd = targetEnd; // Upper bound is the target line itself

                        if (checkLineNum >= displayStart && checkLineNum <= displayEnd) {
                            keepLine = true;
                        }
                    } else {
                        // Multi-line comment: Keep lines strictly within the target range [start..end]
                        if (checkLineNum >= targetStart && checkLineNum <= targetEnd) {
                            keepLine = true;
                        }
                    }
                }
    
                // Append to styledLinesHtml only if keepLine is true
                if (keepLine) {
                    const escapedLineContent = escapeHtml(lineContent);
                    styledLinesHtml += `<span class="line ${lineClass}">` +
                                           `<span class="line-num line-num-old" data-ln="${displayOldLineNum}">${displayOldLineNum}</span>` +
                                           `<span class="line-num line-num-new" data-ln="${displayNewLineNum}">${displayNewLineNum}</span>` +
                                           `<span class="line-content">${escapedLineContent}</span>` +
                                       `</span>`; // No \n
                }
    
            } 
    
            // Assign results to filteredHunkHtml 
            if (!parseError && styledLinesHtml) {
                filteredHunkHtml = `<div class="diff-hunk"><pre><code>${styledLinesHtml}</code></pre></div>`;
            } else if (parseError) {
                 filteredHunkHtml = `<div class="diff-hunk error"><pre><code><span>Error processing diff context.</span></code></pre></div>`;
            } else {
                 console.log("No lines kept for diff hunk, comment:", comment.id, "Range:", commentStartLine, "-", commentEndLine);
                 filteredHunkHtml = `<div class="diff-hunk empty"><pre><code>(Code context for lines ${commentStartLine}-${commentEndLine} not applicable or empty)</code></pre></div>`;
            }
    
        } 
    
        //  Generate line range string for header 
        let lineRangeString = '';
        if (commentStartLine !== null && commentEndLine !== null && commentStartLine !== commentEndLine) {
            lineRangeString = `<span class="line-range"> lines ${commentStartLine} to ${commentEndLine}</span>`;
        } else if (commentEndLine !== null) {
            lineRangeString = `<span class="line-range"> line ${commentEndLine}</span>`;
        }
    
        // Return full comment HTML 
        return `<div class="timeline-item nested-review-comment-item">
                    <div class="item-header">
                         ${user ? `<img class="avatar" src="${user.avatar_url || ''}" alt="${escapeHtml(user?.login || 'unknown user')}" width="18" height="18">`: '<span class="avatar-placeholder" style="width:18px; height:18px;"></span>'}
                        <strong class="author">${escapeHtml(user?.login || 'unknown user')}</strong> commented on
                        ${comment.path ? `<span class="file-path">${escapeHtml(comment.path)}</span>` : ''}
                        ${lineRangeString}
                        ${comment.html_url ? `<a class="gh-link" href="${comment.html_url}" title="View comment on GitHub" target="_blank">🔗</a>` : ''}
                        <span class="timestamp">${createdAt}</span>
                    </div>
                    ${filteredHunkHtml}
                    ${commentBody}
                </div>`;
    }
     

    function generateReviewHtml(review: Review): string {
        const associatedComments = review.associated_comments || [];
        const stateFormatted = formatReviewState(review.state);
        const stateClass = review.state?.toLowerCase() || 'commented';
        const user = review.user;
        const submittedAt = review.submitted_at ? new Date(review.submitted_at).toLocaleString() : '';
        const reviewBody = generateCommentBodyHtml(review);
        const hasMeaningfulState = review.state && review.state !== 'COMMENTED';

        if (!reviewBody && !hasMeaningfulState && associatedComments.length === 0) {
            // No meaningful content to display
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
        // Extract data (handle potential nulls)
        const authorInfo = commitData.commit.author;
        const userAuthor = commitData.author; // GitHub user associated with the commit author email
        const commitShaShort = commitData.sha.substring(0, 7);
        const avatarUrl = userAuthor?.avatar_url || ''; // Use associated GH user avatar if available
        // Prefer GH user login, fallback to commit author name
        const authorName = escapeHtml(userAuthor?.login || authorInfo?.name || 'unknown');
        const commitDate = authorInfo?.date ? new Date(authorInfo.date).toLocaleDateString() : '';
        // Get the first line of the commit message for the title
        const commitTitle = escapeHtml(commitData.commit.message.split('\n')[0]); // Double BS for JS split
        const fullCommitMessage = escapeHtml(commitData.commit.message); // For tooltip
        const commitUrl = commitData.html_url || '';


        // Construct HTML with new structure and classes
        return `<div class="timeline-item commit-item">
                   <div class="item-header">
                        <div class="commit-info">
                            <span class="codicon codicon-git-commit"></span>
                            ${avatarUrl ? `<img class="avatar" src="${avatarUrl}" alt="${authorName}" width="16" height="16">` : '<span class="avatar-placeholder" style="width:16px; height:16px;"></span>'}
                            <span class="author">${authorName}</span>
                            <span class="commit-title" title="${fullCommitMessage}">${commitTitle}</span>
                        </div>
                        <div class="commit-meta">
                            <span class="commit-sha">
                                ${commitUrl ? `<a href="${commitUrl}" target="_blank" title="View commit on GitHub"><code>${commitShaShort}</code></a>` : `<code>${commitShaShort}</code>`}
                            </span>
                            <span class="timestamp">${commitDate}</span>
                        </div>
                   </div>
               </div>`;
   }


    //  Rendering Function 
    function renderTimeline(timelineData: TimelineItem[]) {
        if (!timelineContainer) { console.error("Timeline container not found!"); return; }
        timelineContainer.innerHTML = ''; // Clear previous content ('Loading...' indicator)

        if (!timelineData || timelineData.length === 0) {
            timelineContainer.innerHTML = '<p>No timeline activity found for this pull request.</p>';
            return;
        }

         const fragment = document.createDocumentFragment();
        timelineData.forEach((item: TimelineItem, index: number) => { 
            let elementHtml = '';
            try {
                // Pass the correctly typed data object
                switch (item.type) {
                    case 'review': elementHtml = generateReviewHtml(item.data); break;
                    case 'review_comment': elementHtml = generateReviewCommentHtml(item.data); break; // Should rarely happen if filter works
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
         console.log("Timeline rendering complete.");
    }

    // Message Listener 
    window.addEventListener('message', (event: MessageEvent<FromExtensionMessage>) => {
        const message = event.data;
        switch (message.command) {
            case 'loadDetails':
                console.log('Received full PR details:', message.data);
                if (refreshButton) {
                    refreshButton.disabled = false;
                    refreshButton.classList.remove('loading');
                }
                if (timelineContainer) timelineContainer.innerHTML = ''; // Clear loading indicator
                renderTimeline(message.data.timeline || []);
                renderMetadataHeader(message.data);
                renderMergeStatus(message.data.mergeable, message.data.mergeable_state);
                renderPrDescription(message.data);
                break;

            case 'updateMergeStatus':
                console.log('Received merge status update:', message.data);
                renderMergeStatus(message.data.mergeable, message.data.mergeable_state);
                break;

            case 'updateTimeline':
                renderTimeline(message.timeline);
                break;
                
            case 'showError':
                if (timelineContainer) {
                    timelineContainer.innerHTML = `<p style="color: var(--vscode-errorForeground);">${escapeHtml(message.message)}</p>`;
                }
                break;
        }
    });

    // Refresh Button Listener 
    refreshButton?.addEventListener('click', () => {
        console.log("Refresh button clicked.");
        if (refreshButton && !refreshButton.disabled) {
             // Disable button and show loading state
             refreshButton.disabled = true;
             refreshButton.classList.add('loading');

             // Tell extension host to refresh data for this PR
             vscode.postMessage({ command: 'refreshThisPr' });
        }
    });

    // Merge Button
    confirmMergeButton?.addEventListener('click', () => { 
        if (confirmMergeButton.disabled || !mergeMethodSelect) return; 

        const selectedMethod = mergeMethodSelect.value as 'merge' | 'squash' | 'rebase'; // Get selected method

        if (!selectedMethod) {
             console.error("No merge method selected"); 
             return;
        }

        confirmMergeButton.disabled = true; // Disable button
        confirmMergeButton.innerHTML = `<span class="codicon codicon-sync spin"></span> Merging...`;

        // Send selected method in the message data
        vscode.postMessage({ command: 'mergePr', data: { merge_method: selectedMethod } });
    });

    // Add Comment Button
    addCommentButton?.addEventListener('click', () => {
        if (!commentTextArea || addCommentButton?.disabled) return;
        const commentText = commentTextArea.value.trim();
        if (!commentText) return; // Don't send empty comments

        addCommentButton.disabled = true;
        addCommentButton.innerHTML = `<span class="codicon codicon-sync spin"></span> Posting...`;
        commentTextArea.disabled = true; // Disable textarea while posting

        vscode.postMessage({ command: 'addComment', text: commentText });

        setTimeout(() => {
             if (commentTextArea) {
                  commentTextArea.value = '';
                  commentTextArea.disabled = false;
             }
             if(addCommentButton) {
                 addCommentButton.disabled = false;
                 addCommentButton.innerHTML = `<span class="codicon codicon-comment"></span> Comment`;
             }
        }, 1000); 
    });

    // Close Button
    closeButton?.addEventListener('click', () => {
         if (closeButton?.disabled) return;
         closeButton.disabled = true;
         if (confirmMergeButton) confirmMergeButton.disabled = true; // Disable merge too
         closeButton.innerHTML = `<span class="codicon codicon-sync spin"></span> Closing...`;
         vscode.postMessage({ command: 'closePr' });
    });

    // Signal readiness to extension host
    vscode.postMessage({ command: 'webviewReady' });
    console.log("Webview script initialized and ready.");

}());