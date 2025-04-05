import * as vscode from 'vscode';
import { getGitHubSession, getOctokit } from './auth';
// Assuming PrDataProvider and PullRequestItem are exported from here
import { PrDataProvider, PullRequestItem } from './prDataProvider';
import { Octokit } from '@octokit/rest'; // Import Octokit type
import type { Endpoints } from "@octokit/types"; // Import types for response data
import type { PullRequestInfo } from './prDataProvider';

// --- Type Definitions for GitHub API Responses (can be expanded) ---
type IssueComment = Endpoints["GET /repos/{owner}/{repo}/issues/{issue_number}/comments"]["response"]["data"][0];
type ReviewComment = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"]["response"]["data"][0];
type Review = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"]["response"]["data"][0];
type CommitListItem = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/commits"]["response"]["data"][0];

// --- Timeline Item Structure ---
interface TimelineItemBase {
    timestamp: Date;
}
interface ReviewTimelineItem extends TimelineItemBase {
    type: 'review';
    data: Review;
}
interface ReviewCommentTimelineItem extends TimelineItemBase {
    type: 'review_comment';
    data: ReviewComment;
}
interface IssueCommentTimelineItem extends TimelineItemBase {
    type: 'issue_comment';
    data: IssueComment;
}
interface CommitTimelineItem extends TimelineItemBase {
    type: 'commit';
    data: CommitListItem;
}
type TimelineItem = ReviewTimelineItem | ReviewCommentTimelineItem | IssueCommentTimelineItem | CommitTimelineItem;


let prDataProvider: PrDataProvider | undefined;

// --- Webview Panel Management & Polling ---
interface ActivePrWebview {
    panel: vscode.WebviewPanel;
    prInfo: PullRequestInfo;
    lastCommentCheckTime?: Date; // Use for polling 'since'
    currentTimeline?: TimelineItem[]; // Store last rendered timeline to compare
}
const activePrDetailPanels = new Map<number, ActivePrWebview>(); // Keyed by PR number
let pollingIntervalId: NodeJS.Timeout | undefined = undefined;
const POLLING_INTERVAL_MS = 45000; // Poll every 45 seconds


// =================================
// EXTENSION ACTIVATION FUNCTION
// =================================
export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "your-pr-extension" is now active!');

    // --- 1. Register Tree Data Provider ---
    prDataProvider = new PrDataProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('yourPrViewId', prDataProvider));

    // --- 2. Register Commands ---

    // Refresh Command
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.refreshPrView', () => {
        prDataProvider?.refresh();
        // Also potentially refresh open webviews?
        for (const activeWebview of activePrDetailPanels.values()) {
             updateWebviewContent(context, activeWebview.panel.webview, activeWebview.prInfo);
        }
    }));

        // Create Pull Request Command
        context.subscriptions.push(vscode.commands.registerCommand('yourExtension.createPullRequest', async () => {
            const octokit = await getOctokit();
            if (!octokit) { vscode.window.showErrorMessage("Please sign in to GitHub first."); return; }
            const baseBranch = await vscode.window.showInputBox({ prompt: 'Enter base branch (e.g., main)' });
            if (!baseBranch) return;
            const headBranch = await vscode.window.showInputBox({ prompt: 'Enter head branch (your current branch)' });
            if (!headBranch) return;
            const title = await vscode.window.showInputBox({ prompt: 'Enter PR Title' });
            if (!title) return;
            const body = await vscode.window.showInputBox({ prompt: 'Enter PR Body (optional)' });
    
            // FIXME: Implement proper logic to get owner/repo from current workspace/git remote
            // Get repository owner and name dynamically from git remote
            const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
            if (!gitExtension) {
                vscode.window.showErrorMessage('Git extension not found. Make sure Git is installed and enabled.');
                return;
            }

            const api = gitExtension.getAPI(1);
            const repositories = api.repositories;

            if (!repositories || repositories.length === 0) {
                vscode.window.showErrorMessage('No Git repositories found in the current workspace.');
                return;
            }

            // Use the first repository
            const repository = repositories[0];
            const remotes = repository.state.remotes;

            if (!remotes || remotes.length === 0) {
                vscode.window.showErrorMessage('No Git remotes found in the repository.');
                return;
            }

            // Prefer 'origin' remote if available
            const githubRemote = remotes.find((remote: { name: string }) => remote.name === 'origin') || remotes[0];
            const remoteUrl = githubRemote.fetchUrl || githubRemote.pushUrl;

            if (!remoteUrl) {
                vscode.window.showErrorMessage('Could not determine GitHub remote URL.');
                return;
            }

            // Parse GitHub URL to extract owner and repo name
            let repoOwner = '';
            let repoName = '';

            if (remoteUrl.includes('github.com')) {
                // Handle both HTTPS and SSH formats
                const match = remoteUrl.match(/github\.com[/:](.*?)\/(.*?)(?:\.git)?$/);
                if (match && match.length >= 3) {
                    repoOwner = match[1];
                    repoName = match[2];
                }
            }

            if (!repoOwner || !repoName) {
                vscode.window.showErrorMessage('Could not determine repository owner and name from remote URL.');
                return;
            }
    
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: "Creating Pull Request...", cancellable: false },
                    async (progress) => {
                        const response = await octokit.pulls.create({ owner: repoOwner, repo: repoName, title: title, head: headBranch, base: baseBranch, body: body });
                        if (response.status === 201) {
                            vscode.window.showInformationMessage(`Pull Request #${response.data.number} created successfully!`);
                            prDataProvider?.refresh();
                        } else {
                            vscode.window.showErrorMessage(`Failed to create PR (Status: ${response.status})`);
                        }
                    }
                );
            } catch (err) {
                 console.error("Error creating PR:", err);
                 if(err instanceof Error) {
                     vscode.window.showErrorMessage(`Failed to create Pull Request: ${err.message}`);
                 } else {
                     vscode.window.showErrorMessage(`Failed to create Pull Request: ${String(err)}`);
                 }
             }
        }));

    // Command called when clicking a PR item in the tree
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.viewPullRequest', (itemOrPrInfo: PullRequestItem | PullRequestInfo) => {
        // Handle being called with either the full item or just the info
        const prInfo = (itemOrPrInfo instanceof PullRequestItem) ? itemOrPrInfo.prInfo : itemOrPrInfo;
        createOrShowPrDetailWebview(context, prInfo);
    }));

    // NEW Command for the sidebar diff button
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.viewItemDiff', async (item: PullRequestItem) => {
        // This command receives the TreeItem instance directly
        if (item && item.prInfo) {
            await fetchAndShowDiff(context, item.prInfo);
        } else {
            console.error("viewItemDiff called with invalid item:", item);
            vscode.window.showErrorMessage("Could not get PR info to show diff.");
        }
    }));

    // // View Diff Command
    // context.subscriptions.push(vscode.commands.registerCommand('yourExtension.viewDiff', async (prInfo: PullRequestInfo) => {
    //     // --- (Your existing viewDiff logic - unchanged) ---
    //     await fetchAndShowDiff(context, prInfo);
    //     // --- (End of existing viewDiff logic) ---
    // }));

    // Sign In Command
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.signIn', async () => {
        const session = await getGitHubSession();
        if (session && prDataProvider) {
            await prDataProvider.initialize();
            prDataProvider.refresh();
        }
    }));
}


// =================================
// WEBVIEW PANEL MANAGEMENT
// =================================
async function createOrShowPrDetailWebview(context: vscode.ExtensionContext, prInfo: PullRequestInfo) {
    const column = vscode.window.activeTextEditor?.viewColumn;
    const panelId = prInfo.number; // Use PR number as panel identifier

    const existingActiveWebview = activePrDetailPanels.get(panelId);
    if (existingActiveWebview) {
        existingActiveWebview.panel.reveal(column);
        // Optional: Force update content even if revealing existing
        // await updateWebviewContent(context, existingActiveWebview.panel.webview, prInfo);
        return;
    }

    // Create a new panel.
    const panel = vscode.window.createWebviewPanel(
        'prDetailView', // View type
        `PR #${prInfo.number}`, // Panel title - update dynamically if needed
        column || vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')], // If using external CSS/JS files
             retainContextWhenHidden: true // Keep state when tab is not visible (good for polling)
        }
    );
    panel.title = `PR #${prInfo.number}: ${prInfo.title}`; // Set full title

    const activeWebview: ActivePrWebview = { panel, prInfo, lastCommentCheckTime: new Date() };
    activePrDetailPanels.set(panelId, activeWebview);

    // Set initial content
    await updateWebviewContent(context, panel.webview, prInfo);

    // Handle messages from the webview (if needed)
    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'alert':
                    vscode.window.showErrorMessage(message.text);
                    return;
                 case 'webviewReady': // Message from webview when its JS is loaded
                     // Could trigger initial data load here if preferred over inline script
                     console.log(`Webview for PR #${prInfo.number} is ready.`);
                     return;
            }
        },
        undefined,
        context.subscriptions
    );

    // Clean up when panel is closed
    panel.onDidDispose(
        () => {
            activePrDetailPanels.delete(panelId);
            stopPollingIfNecessary(); // Stop polling if this was the last panel
        },
        null,
        context.subscriptions
    );

    // Start polling if this is the first panel
    startPollingIfNotRunning();
}

// =================================
// WEBVIEW CONTENT UPDATE
// =================================
async function updateWebviewContent(context: vscode.ExtensionContext, webview: vscode.Webview, prInfo: PullRequestInfo) {
    // Store the latest prInfo in the map in case title/etc changes
    const activeWebview = activePrDetailPanels.get(prInfo.number);
    if (activeWebview) {
        activeWebview.prInfo = prInfo;
    }
     webview.html = await getWebviewTimelineHtml(context, webview, prInfo);
}

// =================================
// DATA FETCHING FOR TIMELINE
// =================================
async function fetchPrTimelineData(octokit: Octokit, prInfo: PullRequestInfo): Promise<TimelineItem[]> {
    try {
        const owner = prInfo.repoOwner;
        const repo = prInfo.repoName;
        const pull_number = prInfo.number;

        console.log(`Workspaceing timeline data for PR #${pull_number}`);

        const [reviewsResponse, reviewCommentsResponse, issueCommentsResponse, commitsResponse] = await Promise.all([
            octokit.pulls.listReviews({ owner, repo, pull_number, per_page: 100 }), // Increase per_page or handle pagination
            octokit.pulls.listReviewComments({ owner, repo, pull_number, per_page: 100 }),
            octokit.issues.listComments({ owner, repo, issue_number: pull_number, per_page: 100 }),
            octokit.pulls.listCommits({ owner, repo, pull_number, per_page: 100 })
        ]);

        // *** ADD LOGGING HERE ***
        console.log("--- Raw Review Comments Data ---");
        reviewCommentsResponse.data.forEach(comment => {
            if (!comment.user || comment.user.login === 'pr-respond-test[bot]') { // Log bot comments AND comments with no user? Adjust as needed
                // CORRECTED LOGGING: Use backticks and ensure properties exist
                console.log(`Review Comment #${comment.id} by <span class="math-inline">\{comment\.user?\.login\}\: body\='</span>{comment.body}', body_html='${comment.body_html}'`);
                // console.log(comment); // Log the whole object if needed for more detail
            }
        });
        console.log("--- Raw Issue Comments Data ---");
        issueCommentsResponse.data.forEach(comment => {
            if (!comment.user || comment.user.login === 'pr-respond-test[bot]') {
                // CORRECTED LOGGING: Use backticks and ensure properties exist
                console.log(`Issue Comment #${comment.id} by <span class="math-inline">\{comment\.user?\.login\}\: body\='</span>{comment.body}', body_html='${comment.body_html}'`);
                // console.log(comment); // Log the whole object if needed for more detail
            }
        });
        // *** END LOGGING **

        let timelineItems: TimelineItem[] = [];

        // Process and add items with type and timestamp
        reviewsResponse.data.forEach(item => {
            // Filter out 'PENDING' reviews unless you want to show them
             if (item.state !== 'PENDING' && item.submitted_at) {
                timelineItems.push({ type: 'review', data: item, timestamp: new Date(item.submitted_at) });
             }
        });
        reviewCommentsResponse.data.forEach(item => timelineItems.push({ type: 'review_comment', data: item, timestamp: new Date(item.created_at) }));
        issueCommentsResponse.data.forEach(item => timelineItems.push({ type: 'issue_comment', data: item, timestamp: new Date(item.created_at) }));
        commitsResponse.data.forEach(item => {
             if(item.commit.author?.date) { // Ensure commit date exists
                 timelineItems.push({ type: 'commit', data: item, timestamp: new Date(item.commit.author.date) })
             }
        });


        // --- Sophisticated Grouping (Example - group comments under reviews) ---
        // Create map of comments by review ID
        const commentsByReviewId = new Map<number, ReviewComment[]>();
        reviewCommentsResponse.data.forEach(comment => {
            if (comment.pull_request_review_id) {
                let comments = commentsByReviewId.get(comment.pull_request_review_id) || [];
                comments.push(comment);
                commentsByReviewId.set(comment.pull_request_review_id, comments);
            }
        });

        // Add comments to their review items
         timelineItems = timelineItems.map(item => {
             if (item.type === 'review' && commentsByReviewId.has(item.data.id)) {
                 // Add comments directly to the review data or handle in rendering
                 // For simplicity here, we'll rely on filtering out standalone comments below
             }
             return item;
         });


        // Filter out standalone review comments that BELONG to a fetched review submission
         const submittedReviewIds = new Set(reviewsResponse.data.map(r => r.id));
         timelineItems = timelineItems.filter(item =>
             !(item.type === 'review_comment' && item.data.pull_request_review_id && submittedReviewIds.has(item.data.pull_request_review_id))
         );


        // Sort the final timeline
        timelineItems.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        console.log(`Workspaceed ${timelineItems.length} timeline items for PR #${pull_number}`);
        return timelineItems;

    } catch (e) {
        console.error(`Failed to fetch PR timeline data for #${prInfo.number}:`, e);
        if (e instanceof Error) {
            vscode.window.showErrorMessage(`Failed to fetch PR timeline: ${e.message}`);
        } else {
            vscode.window.showErrorMessage(`Failed to fetch PR timeline: ${String(e)}`);
        }
        return []; // Return empty on error
    }
}

// =================================
// WEBVIEW HTML GENERATION
// =================================
async function getWebviewTimelineHtml(context: vscode.ExtensionContext, webview: vscode.Webview, prInfo: PullRequestInfo): Promise<string> {
    const octokit = await getOctokit();
    let timelineItems: TimelineItem[] = [];

    if (octokit) {
        timelineItems = await fetchPrTimelineData(octokit, prInfo);
        // Store timeline data on the active panel map for polling comparison later
        const activeWebview = activePrDetailPanels.get(prInfo.number);
         if (activeWebview) {
             activeWebview.currentTimeline = timelineItems;
         }
    } else {
        // Handle case where octokit failed to initialize
        return `<body>Error: Could not authenticate with GitHub.</body>`;
    }

    // --- Nonce for Content Security Policy ---
    const nonce = getNonce();

    // --- URIs for local resources ---
    // Example: const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css'));
    // Example: const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.js'));
    // For simplicity, CSS and JS are inlined below

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
        <title>PR #${prInfo.number}</title>
        <style nonce="${nonce}">
            /* --- START INLINE CSS --- */
            /* Using VS Code variables for theme consistency */
            body {
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                padding: 15px 25px;
            }
            a {
                color: var(--vscode-textLink-foreground);
                text-decoration: none;
            }
            a:hover { text-decoration: underline; }
            a:focus, button:focus { outline-color: var(--vscode-focusBorder); }
            code {
                 font-family: var(--vscode-editor-font-family);
                 font-size: calc(var(--vscode-editor-font-size) * 0.9); /* Slightly smaller code font */
                 background-color: var(--vscode-textBlockQuote-background);
                 border: 1px solid var(--vscode-button-secondaryBackground);
                 border-radius: 3px;
                 padding: 0.1em 0.3em;
            }
            pre { /* Used for diff hunks */
                 font-family: var(--vscode-editor-font-family);
                 font-size: var(--vscode-editor-font-size);
                 line-height: var(--vscode-editor-line-height);
                 background-color: var(--vscode-textBlockQuote-background);
                 padding: 10px;
                 border: 1px solid var(--vscode-editorWidget-border, #444);
                 border-radius: 4px;
                 overflow-x: auto;
            }
             pre code { /* Reset styles for code inside pre (diff hunk lines) */
                 background-color: transparent;
                 padding: 0;
                 border: none;
                 border-radius: 0;
                 font-size: inherit; /* Inherit pre font size */
             }
            .avatar { border-radius: 50%; vertical-align: middle; border: 1px solid var(--vscode-editorWidget-border, #444); }
            .avatar-placeholder { display: inline-block; width: 20px; height: 20px; background-color: var(--vscode-editorWidget-border); border-radius: 50%; vertical-align: middle; }
            hr { border: none; border-top: 1px solid var(--vscode-editorWidget-border, #444); margin: 15px 0; }

            #timeline-area { margin-top: 20px; }
            .timeline-item { margin-bottom: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-editorWidget-border, #444); }
            .timeline-item:first-child { border-top: none; padding-top: 0; }

            .item-header { margin-bottom: 8px; display: flex; align-items: center; gap: 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground); flex-wrap: wrap; }
            .item-header .author { font-weight: bold; color: var(--vscode-editor-foreground); }
            .timestamp { font-size: 0.9em; white-space: nowrap; opacity: 0.8; margin-left: auto; } /* Push right */
            .file-path { font-family: var(--vscode-editor-font-family); background-color: var(--vscode-textBlockQuote-background); padding: 1px 4px; border-radius: 3px; border: 1px solid var(--vscode-button-secondaryBackground); }
            .gh-link { margin-left: 5px; font-size: 0.9em; opacity: 0.7; }
            .gh-link:hover { opacity: 1; }

            /* Diff Hunk Specific */
            .diff-hunk { border: 1px solid var(--vscode-editorWidget-border, #ccc); border-radius: 4px; margin-bottom: 8px; overflow-x: auto; }
            .diff-hunk pre { margin: 0; padding: 0; background-color: var(--vscode-editor-background); border-radius: 4px; }
             /* Diff line styling */
             .diff-hunk code span { display: block; padding: 0 10px; border-left: 3px solid transparent; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre; }
             .diff-hunk code span.addition { background-color: rgba(47, 131, 47, 0.15); border-left-color: var(--vscode-gitDecoration-addedResourceForeground); }
             .diff-hunk code span.deletion { background-color: rgba(188, 76, 0, 0.15); border-left-color: var(--vscode-gitDecoration-deletedResourceForeground); }
             .diff-hunk code span.hunk-header { color: var(--vscode-descriptionForeground); background-color: var(--vscode-textBlockQuote-background); padding: 2px 10px; font-style: italic; border-left: none; }

            /* Comment Body */
            .comment-body { padding: 5px 0; margin-left: 28px; /* Indent body relative to avatar */ margin-top: -5px; line-height: 1.4; }
            .comment-body p:first-child { margin-top: 0; }
            .comment-body p:last-child { margin-bottom: 0; }
            .comment-body ul, .comment-body ol { margin-left: 20px; }
            .comment-body pre { /* Code blocks *within* comments */
                 background-color: var(--vscode-textBlockQuote-background);
                 border: 1px solid var(--vscode-button-secondaryBackground);
                 padding: 8px;
                 margin: 5px 0;
            }

            /* Review States */
            .review-state { font-weight: bold; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
            .review-state.approved { color: var(--vscode-gitDecoration-addedResourceForeground); background-color: rgba(47, 131, 47, 0.15); }
            .review-state.commented { color: var(--vscode-descriptionForeground); background-color: var(--vscode-textBlockQuote-background); }
            .review-state.changes_requested { color: var(--vscode-gitDecoration-modifiedResourceForeground); background-color: rgba(188, 76, 0, 0.15); }
            .review-state.dismissed { color: var(--vscode-descriptionForeground); background-color: var(--vscode-textBlockQuote-background); text-decoration: line-through; }

            /* Commit Items */
            .commit-item .item-header { gap: 5px; }
            .commit-message { margin-left: 28px; margin-top: -5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .commit-item code { font-size: 0.85em; }
            /* --- END INLINE CSS --- */
        </style>
    </head>
    <body>
        <h1><a href="${prInfo.url}" target="_blank">#${prInfo.number}: ${escapeHtml(prInfo.title)}</a></h1>
        <p>Author: ${escapeHtml(prInfo.author)}</p>
        <hr>
        <div id="timeline-area">
            <p>Loading timeline...</p>
        </div>

        <script nonce="${nonce}">
            /* --- START INLINE JAVASCRIPT --- */
            (function() {
                const vscode = acquireVsCodeApi();
                const timelineContainer = document.getElementById('timeline-area');
                // Initial data passed from the extension
                const initialTimelineData = ${JSON.stringify(timelineItems)};

                 // Helper function to safely escape HTML - USE ONLY FOR PLAIN TEXT
                 function escapeHtml(unsafe) {
                     if (typeof unsafe !== 'string') return '';
                     return unsafe
                          .replace(/&/g, "&amp;")
                          .replace(/</g, "&lt;")
                          .replace(/>/g, "&gt;")
                          .replace(/"/g, "&quot;")
                          .replace(/'/g, "&#039;");
                 }

                // Helper to format review state nicely
                function formatReviewState(state) {
                    switch (state?.toUpperCase()) {
                        case 'APPROVED': return 'approved';
                        case 'CHANGES_REQUESTED': return 'requested changes';
                        case 'COMMENTED': return 'commented';
                        case 'DISMISSED': return 'dismissed review';
                        default: return state?.toLowerCase() || 'reviewed';
                    }
                }

                 // --- HTML Generation Functions (REVISED with null checks and correct body_html usage) ---
                function generateReviewHtml(review) {
                    const stateFormatted = formatReviewState(review.state);
                    const stateClass = review.state?.toLowerCase() || 'commented';
                    const user = review.user; // Check if user exists
                    const submittedAt = review.submitted_at ? new Date(review.submitted_at).toLocaleString() : '';
                    const reviewBodyHtml = (review.body_html && review.body_html.trim() !== '') ? \`<div class="comment-body">\${review.body_html}</div>\` : '';

                    return \`<div class="timeline-item review-submission-item">
                                <div class="item-header">
                                    \${user ? \`<img class="avatar" src="\${user.avatar_url || ''}" alt="\${escapeHtml(user.login || '')}" width="20" height="20">\`: '<span class="avatar-placeholder"></span>'}
                                    <strong class="author">\${escapeHtml(user?.login || 'unknown user')}</strong>
                                    <span class="review-state \${stateClass}">\${stateFormatted}</span>
                                    \${review.html_url ? \`<a class="gh-link" href="\${review.html_url}" title="View on GitHub" target="_blank">🔗</a>\` : ''}
                                    <span class="timestamp">\${submittedAt}</span>
                                </div>
                                \${reviewBodyHtml} 
                            </div>\`;
                }

                function generateReviewCommentHtml(comment) {
                    const user = comment.user;
                    const createdAt = comment.created_at ? new Date(comment.created_at).toLocaleString() : '';
                    const diffHunkHtml = (comment.diff_hunk && comment.diff_hunk.trim() !== '') ? \`<div class="diff-hunk"><pre><code>\${escapeHtml(comment.diff_hunk)}</code></pre></div>\` : ''; // Diff hunk IS plain text, escape it
                    
                    // --- MODIFICATION START ---
                    let commentBodyContent = '';
                    if (comment.body_html && comment.body_html.trim() !== '') {
                        commentBodyContent = comment.body_html; // Use HTML version if available
                    } else if (comment.body && comment.body.trim() !== '') {
                        // Fallback to raw body: Escape it and wrap in <pre> for formatting
                        console.log(\`Falling back to comment.body for comment #\${comment.id}\`); // Optional: log fallback
                        commentBodyContent = \`<pre style="white-space: pre-wrap; word-wrap: break-word;">\${escapeHtml(comment.body)}</pre>\`;
                    }
                    // --- MODIFICATION END ---
                    
                    // Use the determined content (This line MUST be here)
                    const commentBodyHtml = commentBodyContent ? \`<div class="comment-body">\${commentBodyContent}</div>\` : '';

                    return \`<div class="timeline-item review-comment-item">
                                <div class="item-header">
                                     \${user ? \`<img class="avatar" src="\${user.avatar_url || ''}" alt="\${escapeHtml(user.login || '')}" width="20" height="20">\`: '<span class="avatar-placeholder"></span>'}
                                    <strong class="author">\${escapeHtml(user?.login || 'unknown user')}</strong> commented on
                                    \${comment.path ? \`<span class="file-path">\${escapeHtml(comment.path)}</span>\` : ''}
                                    \${comment.html_url ? \`<a class="gh-link" href="\${comment.html_url}" title="View on GitHub" target="_blank">🔗</a>\` : ''}
                                    <span class="timestamp">\${createdAt}</span>
                                </div>
                                \${diffHunkHtml}
                                \${commentBodyHtml}
                            </div>\`;
                }

                function generateIssueCommentHtml(comment) {
                     const user = comment.user;
                     const createdAt = comment.created_at ? new Date(comment.created_at).toLocaleString() : '';

                    // --- MODIFICATION LOGIC ---
                    let commentBodyContent = '';
                    if (comment.body_html && comment.body_html.trim() !== '') {
                        commentBodyContent = comment.body_html; // Use HTML version if available
                    } else if (comment.body && comment.body.trim() !== '') {
                        // Fallback to raw body: Escape it and wrap in <pre> for formatting
                        console.log(\`Falling back to comment.body for comment #\${comment.id}\`); // Optional: log fallback
                        commentBodyContent = \`<pre style="white-space: pre-wrap; word-wrap: break-word;">\${escapeHtml(comment.body)}</pre>\`;
                    }
                    // --- END MODIFICATION LOGIC ---

                    // Use the determined content (This line MUST be here)
                    const commentBodyHtml = commentBodyContent ? \`<div class="comment-body">\${commentBodyContent}</div>\` : '';

                    return \`<div class="timeline-item issue-comment-item">
                                <div class="item-header">
                                    \${user ? \`<img class="avatar" src="\${user.avatar_url || ''}" alt="\${escapeHtml(user.login || '')}" width="20" height="20">\`: '<span class="avatar-placeholder"></span>'}
                                    <strong class="author">\${escapeHtml(user?.login || 'unknown user')}</strong> commented
                                    \${comment.html_url ? \`<a class="gh-link" href="\${comment.html_url}" title="View on GitHub" target="_blank">🔗</a>\` : ''}
                                    <span class="timestamp">\${createdAt}</span>
                                </div>
                                \${commentBodyHtml}
                            </div>\`;
                }

                function generateCommitHtml(commitData) {
                     const authorInfo = commitData.commit.author;
                     const committerInfo = commitData.commit.committer;
                     const userAuthor = commitData.author;
                     const commitShaShort = commitData.sha.substring(0, 7);
                     const avatarUrl = userAuthor?.avatar_url || '';
                     const authorName = escapeHtml(authorInfo?.name || userAuthor?.login || 'unknown');
                     const commitDate = authorInfo?.date ? new Date(authorInfo.date).toLocaleString() : (committerInfo?.date ? new Date(committerInfo.date).toLocaleString() : '');
                     const commitMessage = escapeHtml(commitData.commit.message.split('\\n')[0]); // First line only
                     const commitUrl = commitData.html_url || '';

                     return \`<div class="timeline-item commit-item">
                                <div class="item-header">
                                     \${avatarUrl ? \`<img class="avatar" src="\${avatarUrl}" alt="\${authorName}" width="20" height="20">\` : '<span class="avatar-placeholder"></span>'}
                                     <span class="author">\${authorName}</span> committed
                                     \${commitUrl ? \`<a href="\${commitUrl}" target="_blank"><code>\${commitShaShort}</code></a>\` : \`<code>\${commitShaShort}</code>\`}
                                     <span class="timestamp">\${commitDate}</span>
                                </div>
                                 <div class="comment-body commit-message" title="\${escapeHtml(commitData.commit.message)}">\${commitMessage}</div>
                             </div>\`;
                }

                 // Function to parse diff hunks and add styling
                 function parseAndStyleDiffHunks() {
                     if (!timelineContainer) return;
                     timelineContainer.querySelectorAll('.diff-hunk pre code').forEach(block => {
                         if(block.dataset.styled) return; // Avoid re-styling
                         // Ensure textContent is treated as a string
                         const lines = String(block.textContent || '').split('\\n');
                         let styledLines = '';
                         lines.forEach(line => {
                             let lineClass = '';
                             // Use startsWith safely
                             if (line.startsWith('+')) { lineClass = 'addition'; }
                             else if (line.startsWith('-')) { lineClass = 'deletion'; }
                             else if (line.startsWith('@@')) { lineClass = 'hunk-header'; }
                             // Escape the line content itself before embedding in span
                             styledLines += \`<span class="\${lineClass}">\${escapeHtml(line)}\\n</span>\`;
                         });
                         // Replace the content with styled spans
                         block.innerHTML = styledLines;
                         block.dataset.styled = 'true'; // Mark as styled
                     });
                 }


                // --- Main Rendering Function ---
                function renderTimeline(timelineData) {
                    if (!timelineContainer) { console.error("Timeline container not found!"); return; }
                    timelineContainer.innerHTML = ''; // Clear previous content

                    if (!timelineData || timelineData.length === 0) {
                        timelineContainer.innerHTML = '<p>No timeline activity found for this pull request.</p>';
                        return;
                    }

                     console.log(\`Rendering \${timelineData.length} timeline items...\`);
                     const fragment = document.createDocumentFragment();
                    timelineData.forEach((item, index) => {
                        let elementHtml = '';
                        try {
                            // console.log(\`Rendering item \${index}:\`, item); // Uncomment for deep debug
                            switch (item.type) {
                                case 'review': elementHtml = generateReviewHtml(item.data); break;
                                case 'review_comment': elementHtml = generateReviewCommentHtml(item.data); break;
                                case 'issue_comment': elementHtml = generateIssueCommentHtml(item.data); break;
                                case 'commit': elementHtml = generateCommitHtml(item.data); break;
                                default: console.warn("Unknown timeline item type:", item.type);
                            }
                        } catch (e) {
                             console.error(\`Error generating HTML for item index \${index}:\`, item, e);
                             elementHtml = \`<div class="timeline-item error-item">Error rendering item. See Webview DevTools console.</div>\`;
                        }

                        if (elementHtml) {
                            const template = document.createElement('template');
                            template.innerHTML = elementHtml.trim();
                             if (template.content.firstChild) {
                                 fragment.appendChild(template.content.firstChild);
                             } else {
                                  console.warn(\`Generated empty HTML for item index \${index}:\`, item);
                             }
                        }
                    });
                    timelineContainer.appendChild(fragment);
                    try {
                         parseAndStyleDiffHunks(); // Style diffs after inserting into DOM
                    } catch(e) {
                         console.error("Error styling diff hunks:", e);
                    }
                     console.log("Timeline rendering complete.");
                }

                // --- Message Listener for Updates ---
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'updateTimeline': // Command sent by polling function
                            console.log('Received timeline update from extension:', message.timeline);
                            renderTimeline(message.timeline);
                            break;
                    }
                });

                // --- Initial Render ---
                // FIX: Ensure this line is correct and has the closing parenthesis!
                renderTimeline(initialTimelineData);

                // Optional: Notify extension that webview is ready
                // vscode.postMessage({ command: 'webviewReady' });

            }());
            /* --- END INLINE JAVASCRIPT --- */
        </script>
    </body>
    </html>`;
}


// =================================
// POLLING LOGIC
// =================================

function startPollingIfNotRunning() {
    if (!pollingIntervalId && activePrDetailPanels.size > 0) {
        console.log("Starting PR timeline polling...");
        pollingIntervalId = setInterval(pollForUpdates, POLLING_INTERVAL_MS);
    }
}

function stopPollingIfNecessary() {
    if (pollingIntervalId && activePrDetailPanels.size === 0) {
        console.log("Stopping PR timeline polling.");
        clearInterval(pollingIntervalId);
        pollingIntervalId = undefined;
    }
}

async function pollForUpdates() {
    if (activePrDetailPanels.size === 0) {
        console.log("Polling skipped: No active PR detail panels.");
        return;
    }

    console.log(`Polling for updates on ${activePrDetailPanels.size} PR(s)...`);
    const octokit = await getOctokit();
    if (!octokit) {
        console.warn("Polling skipped: Octokit not available.");
        return;
    }

    // Use Promise.all to poll concurrently
    const updateChecks = Array.from(activePrDetailPanels.values()).map(async (activeWebview) => {
        // Only poll visible panels if desired (can save API calls)
        // if (!activeWebview.panel.visible) return;

        try {
            const prInfo = activeWebview.prInfo;
            const newTimeline = await fetchPrTimelineData(octokit, prInfo);

            // --- Simple Comparison Logic (Improve this) ---
            // Compare new timeline length/items with stored one. A proper diff is better.
            const hasChanged = JSON.stringify(newTimeline) !== JSON.stringify(activeWebview.currentTimeline);

            if (hasChanged) {
                console.log(`Timeline changed for PR #${prInfo.number}. Notifying webview.`);
                activeWebview.currentTimeline = newTimeline; // Update stored timeline
                activeWebview.panel.webview.postMessage({
                    command: 'updateTimeline',
                    timeline: newTimeline
                });
            } else {
                 console.log(`No changes detected for PR #${prInfo.number}.`);
            }
             activeWebview.lastCommentCheckTime = new Date(); // Update check time regardless

        } catch (error) {
            console.error(`Error polling timeline for PR #${activeWebview.prInfo.number}:`, error);
        }
    });

    await Promise.all(updateChecks);
    console.log("Polling cycle finished.");
}


// =================================
// DIFF VIEW LOGIC
// =================================
async function fetchAndShowDiff(context: vscode.ExtensionContext, prInfo: PullRequestInfo) {
    const octokit = await getOctokit();
    if (!octokit) { vscode.window.showErrorMessage("Please sign in to GitHub first."); return; };

    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching Diff...", cancellable: false }, async (progress) => {

            progress.report({ message: "Fetching PR details..." });
            const { data: pull } = await octokit.pulls.get({
                owner: prInfo.repoOwner,
                repo: prInfo.repoName,
                pull_number: prInfo.number,
            });
            const baseSha = pull.base.sha;
            const headSha = pull.head.sha;

             progress.report({ message: "Fetching changed files..." });
            const { data: files } = await octokit.pulls.listFiles({
                 owner: prInfo.repoOwner,
                 repo: prInfo.repoName,
                 pull_number: prInfo.number,
                 per_page: 300 // Handle up to 300 files, pagination needed for more
            });

            if (!files || files.length === 0) {
                vscode.window.showInformationMessage("No changes detected in this pull request.");
                return;
            }

            // Let user pick a file if more than one? For now, just use the first.
            // In a real app, you'd show a Quick Pick list here.
             const file = files[0];
             progress.report({ message: `Diffing ${file.filename}...` });

             if (file.status === 'added') {
                 try {
                     const { data: contentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: file.filename, ref: headSha });
                     // Need to handle potential array response if it's a directory (unlikely for listFiles result)
                     const headContent = Buffer.from((contentData as any).content, 'base64').toString('utf8');
                     // Create empty temp file for base
                     const baseUri = await createTempFile(context, `${prInfo.number}-${baseSha}-EMPTY-${file.filename}`, '');
                     const headUri = await createTempFile(context, `${prInfo.number}-${headSha}-${file.filename}`, headContent);
                     const diffTitle = `${file.filename} (Added in PR #${prInfo.number})`;
                     vscode.commands.executeCommand('vscode.diff', baseUri, headUri, diffTitle);
                 } catch (err) { handleDiffError(err, file.filename); }

             } else if (file.status === 'removed') {
                  try {
                     const { data: contentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: file.filename, ref: baseSha }); // Get content from BASE commit
                     const baseContent = Buffer.from((contentData as any).content, 'base64').toString('utf8');
                     const baseUri = await createTempFile(context, `${prInfo.number}-${baseSha}-${file.filename}`, baseContent);
                     // Create empty temp file for head
                     const headUri = await createTempFile(context, `${prInfo.number}-${headSha}-REMOVED-${file.filename}`, '');
                     const diffTitle = `${file.filename} (Removed in PR #${prInfo.number})`;
                     vscode.commands.executeCommand('vscode.diff', baseUri, headUri, diffTitle);
                 } catch (err) { handleDiffError(err, file.filename); }

             } else { // Modified, renamed etc.
                 try {
                    // Fetch file content for base and head commits
                     const { data: baseContentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: file.filename, ref: baseSha });
                     const { data: headContentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: file.filename, ref: headSha });

                     const baseContent = Buffer.from((baseContentData as any).content, 'base64').toString('utf8');
                     const headContent = Buffer.from((headContentData as any).content, 'base64').toString('utf8');

                    // Create temporary files
                    const baseUri = await createTempFile(context, `${prInfo.number}-${baseSha}-${file.filename}`, baseContent);
                    const headUri = await createTempFile(context, `${prInfo.number}-${headSha}-${file.filename}`, headContent);

                    // Execute the built-in diff command
                    const diffTitle = `${file.filename} (PR #${prInfo.number})`;
                    vscode.commands.executeCommand('vscode.diff', baseUri, headUri, diffTitle);
                 } catch (err) { handleDiffError(err, file.filename); }
             }
        });
     } catch (err) { // Catch errors from the overall process (e.g., listFiles)
        console.error("Error in fetchAndShowDiff:", err);
        if(err instanceof Error) {
           vscode.window.showErrorMessage(`Failed to show diff: ${err.message}`);
        } else {
            vscode.window.showErrorMessage(`Failed to show diff: ${String(err)}`);
        }
     }
}

// Helper for specific diff errors
function handleDiffError(err: any, filename: string) {
    console.error(`Error fetching content for diff of ${filename}:`, err);
    if(err instanceof Error) {
        // Handle common case where file might be too large or not found in one of the commits
         if (err.message.includes("Not Found") || err.message.includes("too large")) {
             vscode.window.showErrorMessage(`Could not get content for ${filename}: ${err.message}`);
         } else {
             vscode.window.showErrorMessage(`Error diffing ${filename}: ${err.message}`);
         }
    } else {
         vscode.window.showErrorMessage(`Error diffing ${filename}: ${String(err)}`);
    }
}

let tempFiles: vscode.Uri[] = []; // Keep temp file tracking
async function createTempFile(context: vscode.ExtensionContext, fileName: string, content: string): Promise<vscode.Uri> {
    // Use extension's global storage path for temp files
    const safeFileName = fileName.replace(/[\\/?*:|"<>]/g, '_'); // More robust sanitization
    // Ensure global storage directory exists (VS Code should handle this, but belt-and-suspenders)
    try { await vscode.workspace.fs.createDirectory(context.globalStorageUri); } catch(e) { /* Ignore if already exists */ }
    const uri = vscode.Uri.joinPath(context.globalStorageUri, safeFileName);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    if (!tempFiles.some(existingUri => existingUri.toString() === uri.toString())) {
         tempFiles.push(uri); // Track for cleanup, avoid duplicates
    }
    return uri;
}



// =================================
// EXTENSION DEACTIVATION
// =================================
export function deactivate() {
    // Stop polling
    if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
        pollingIntervalId = undefined;
         console.log("Polling stopped on deactivation.");
    }
    activePrDetailPanels.clear();

    // Clean up temporary diff files
    // Use Promise.allSettled to attempt deleting all even if some fail
    Promise.allSettled(
        tempFiles.map(uri => {
            console.log(`Attempting to delete temp file: ${uri.fsPath}`);
            return Promise.resolve(vscode.workspace.fs.delete(uri)).catch(e => {
                // Catch deletion error for individual files but don't stop others
                console.warn(`Failed to delete temp file ${uri.fsPath}:`, e);
            });
        })
    )
    .then((results) => {
        const deletedCount = results.filter(r => r.status === 'fulfilled').length;
        const failedCount = results.filter(r => r.status === 'rejected').length;
        console.log(`Cleaned up ${deletedCount} temporary diff files. ${failedCount > 0 ? `${failedCount} failed.` : ''}`);
    });
    tempFiles = []; // Clear the array

    console.log("Your PR extension deactivated.");
}

// Helper to escape HTML entities (ensure it handles non-strings)
function escapeHtml(unsafe: unknown): string {
    if (typeof unsafe !== 'string') {
        if (unsafe === null || typeof unsafe === 'undefined') { return ''; }
        try { return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
        catch (e) { return ''; }
    }
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
 }

// Helper to generate nonce for CSP
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}