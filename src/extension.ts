import * as vscode from 'vscode';
import { getGitHubSession, getOctokit } from './auth';
// Assuming PrDataProvider and PullRequestItem are exported from here
import { PrDataProvider, PullRequestItem } from './prDataProvider';
import { Octokit } from '@octokit/rest'; // Import Octokit type
import type { Endpoints } from "@octokit/types"; // Import types for response data
import type { PullRequestInfo } from './prDataProvider';

import * as fs from 'fs';
import * as path from 'path';

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
    // Let's add the associated comments directly to the data payload for simplicity
    data: Review & { associated_comments?: ReviewComment[] }; // Add associated_comments here
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

    const generatedHtml = await getWebviewTimelineHtml(context, webview, prInfo);

     // --- WRITE TO FILE ---
    try {
        // Ensure the global storage directory exists
        // Note: Using fs promises API might require async/await if needed elsewhere
        // For simplicity here, using synchronous check/create, assuming context.globalStorageUri is available
        if (!fs.existsSync(context.globalStorageUri.fsPath)) {
             fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
        }

        // Define the file path within the extension's global storage
        const filePath = path.join(context.globalStorageUri.fsPath, `webview_debug_pr_${prInfo.number}.html`);
        fs.writeFileSync(filePath, generatedHtml, 'utf8');
        console.log(`DEBUG: Wrote generated HTML for PR ${prInfo.number} to: ${filePath}`);
        // You can reveal this file in the explorer if desired:
        // vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
    } catch (err) {
        console.error("DEBUG: Error writing debug HTML file:", err);
        vscode.window.showErrorMessage(`Failed to write debug HTML file: ${err}`);
    }
    // --- END WRITE TO FILE ---

    webview.html = generatedHtml; // Assign the already generated HTML
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

        

        // reviewsResponse.data.forEach(comment => {
        //     // Log bot comments or any comment missing body_html
        //     console.log("--------REVIEW RESPONSE STARTS--------");

        //     console.log(`Review Comment #${comment.id} by ${comment.user?.login}`);
        //     console.log(`  -> body_html: ${comment.body_html}`);
        //     console.log(`  -> body: ${comment.body}`); // Log body content separately
        //     // console.log(comment); // Optional: Log the whole object

        //     console.log("--------REVIEW RESPONSE ENDS--------");

        // });


        // console.log("--- Raw Review Comments Data ---");
        // reviewCommentsResponse.data.forEach(comment => {
        //     // Log bot comments or any comment missing body_html
        //     if ((comment.user?.login === 'pr-respond-test[bot]') || !comment.body_html) {
        //         console.log(`Review Comment #${comment.id} by ${comment.user?.login}`);
        //         console.log(`  -> body_html: ${comment.body_html}`);
        //         console.log(`  -> body: ${comment.body}`); // Log body content separately
        //         // console.log(comment); // Optional: Log the whole object
        //     }
        // });
        // console.log("--- Raw Issue Comments Data ---");
        // issueCommentsResponse.data.forEach(comment => {
        //      // Log bot comments or any comment missing body_html
        //      if ((comment.user?.login === 'pr-respond-test[bot]') || !comment.body_html) {
        //         console.log(`Issue Comment #${comment.id} by ${comment.user?.login}`);
        //         console.log(`  -> body_html: ${comment.body_html}`);
        //         console.log(`  -> body: ${comment.body}`); // Log body content separately
        //         // console.log(comment); // Optional: Log the whole object
        //      }
        // });

        // --- 1. Create a Map of Review Comments by Review ID ---
        const commentsByReviewId = new Map<number, ReviewComment[]>();
        reviewCommentsResponse.data.forEach(comment => {
            if (comment.pull_request_review_id) {
                const comments = commentsByReviewId.get(comment.pull_request_review_id) || [];
                comments.push(comment);
                // Sort comments within a review by creation time? Optional.
                // comments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
                commentsByReviewId.set(comment.pull_request_review_id, comments);
            }
            // We could potentially handle comments without a review_id here if needed,
            // but they shouldn't normally occur from this endpoint.
        });
        console.log(`Mapped ${commentsByReviewId.size} reviews with associated comments.`);


        // --- 2. Initialize Timeline Items ---
        let timelineItems: TimelineItem[] = [];

        // --- 3. Process Reviews and Attach Comments ---
        reviewsResponse.data.forEach(review => {
            // Filter out 'PENDING' reviews unless you want to show them
             if (review.state !== 'PENDING' && review.submitted_at) {
                 // Find associated comments from the map
                 const associated_comments = commentsByReviewId.get(review.id) || [];
                 if(associated_comments.length > 0) {
                     console.log(`Attaching ${associated_comments.length} comments to review ${review.id}`);
                 }
                 // Add the review submission, INCLUDING the associated comments in its data
                 timelineItems.push({
                     type: 'review',
                     // Cast review to include the optional property
                     data: { ...review, associated_comments: associated_comments },
                     timestamp: new Date(review.submitted_at)
                 });
             }
        });

        // --- 4. Process Other Timeline Items (Review Comments, Issue Comments, Commits) ---
        // Add standalone review comments (these should ideally be filtered later)
        reviewCommentsResponse.data.forEach(item => timelineItems.push({ type: 'review_comment', data: item, timestamp: new Date(item.created_at) }));
        // Add issue comments
        issueCommentsResponse.data.forEach(item => timelineItems.push({ type: 'issue_comment', data: item, timestamp: new Date(item.created_at) }));
        // Add commits
        commitsResponse.data.forEach(item => {
             if(item.commit.author?.date) {
                 timelineItems.push({ type: 'commit', data: item, timestamp: new Date(item.commit.author.date) })
             }
        });



        // --- 5. Re-enable the Filter ---
        // Filter out standalone review comments that BELONG to a fetched review submission
        // (because we will render them *within* the review submission item)
        const submittedReviewIds = new Set(reviewsResponse.data.map(r => r.id));
        const originalCount = timelineItems.length; // For logging
        timelineItems = timelineItems.filter(item =>
            !(item.type === 'review_comment' && item.data.pull_request_review_id && submittedReviewIds.has(item.data.pull_request_review_id))
        );
        console.log(`Filtered out ${originalCount - timelineItems.length} standalone review comments associated with fetched reviews.`);


        // --- 6. Sort the Final Timeline ---
        timelineItems.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        console.log(`Processed ${timelineItems.length} final timeline items for PR #${pull_number}`);
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
             
            .diff-hunk .line { 
                display: flex; 
                white-space: nowrap;
                margin: 0; /* Reset margin */
                padding: 0; /* Reset padding */
            } 
            .diff-hunk .line-num {
                /* display: inline-block; */ /* Remove this - let it be a flex item */
                flex-shrink: 0; /* Prevent line number column from shrinking */
                width: 45px; /* Maybe slightly wider for 3 digits? */
                padding-right: 10px;
                text-align: right;
                opacity: 0.7;
                user-select: none;
                color: var(--vscode-editorLineNumber-foreground);
                /* Match font of code for better vertical alignment */
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size); /* Match font size */
                line-height: var(--vscode-editor-line-height); /* Match editor line height */
                margin: 0;
                padding: 0 10px 0 0; /* Adjust padding */
            }
            /* Style hunk header line number cell */
             .diff-hunk .line.hunk-header .line-num {
                 opacity: 0.5; /* Make it dimmer */
             }
            /* Ensure content part takes remaining space */
            .diff-hunk .line-content { 
                flex-grow: 1;
                white-space: pre;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                /* Add these: */
                line-height: var(--vscode-editor-line-height); /* Match editor line height */
                margin: 0;
                padding-top: 0;    /* Remove potential default padding */
                padding-bottom: 0;
                /* Padding-left/border is handled by type */
            }
            
            /* Adjust padding/border styles for line-content */
            .diff-hunk .line-content.addition { background-color: rgba(47, 131, 47, 0.15); border-left: 3px solid var(--vscode-gitDecoration-addedResourceForeground); padding-left: 10px; }
            .diff-hunk .line-content.deletion { background-color: rgba(188, 76, 0, 0.15); border-left: 3px solid var(--vscode-gitDecoration-deletedResourceForeground); padding-left: 10px; }
            .diff-hunk .line-content.hunk-header { color: var(--vscode-descriptionForeground); background-color: var(--vscode-textBlockQuote-background); padding: 2px 10px; font-style: italic; border-left: none; } /* Reset border */
            .diff-hunk .line-content.context { border-left: 3px solid transparent; padding-left: 10px; }

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

                // --- NEW: Helper to generate HTML for a single comment's body ---
                 // This reuses the fallback logic
                 function generateCommentBodyHtml(comment) {
                    let commentBodyContent = '';
                    if (comment.body_html && comment.body_html.trim() !== '') {
                        commentBodyContent = comment.body_html; // Use HTML version if available
                    } else if (comment.body && comment.body.trim() !== '') {
                        // Fallback to raw body: Escape it and wrap in <pre>
                        // console.log(\`Falling back to comment.body for comment #\${comment.id}\`); // Optional log
                        commentBodyContent = \`<pre style="white-space: pre-wrap; word-wrap: break-word;">\${escapeHtml(comment.body)}</pre>\`;
                    }
                    return commentBodyContent ? \`<div class="comment-body">\${commentBodyContent}</div>\` : '';
                 }

                // --- NEW: Helper to generate HTML for a single review comment (used for nesting) ---
                // Simplified version of generateReviewCommentHtml, focusing on the comment itself
                
                function generateNestedReviewCommentHtml(comment) {
                    const user = comment.user;
                    const createdAt = comment.created_at ? new Date(comment.created_at).toLocaleString() : '';
                    const commentBody = generateCommentBodyHtml(comment); // Assumes helper exists

                    let filteredHunkHtml = '';
                    const diffHunk = comment.diff_hunk;
                    const commentEndLine = (typeof comment.line === 'number') ? comment.line : null;
                    const commentStartLine = (typeof comment.start_line === 'number') ? comment.start_line : commentEndLine; // Default start=end

                    // Determine if it's a single line comment for context adjustment
                    const isSingleLineComment = (commentStartLine === commentEndLine);
                    const CONTEXT_LINES_BEFORE = 3; // How many lines before to show for single-line comments

                    if (diffHunk && commentEndLine !== null && commentStartLine !== null) {
                        const lines = diffHunk.split('\\n');
                        let styledLinesHtml = '';
                        let currentFileLineNum = -1;
                        let hunkHeaderFound = false;
                        let parseError = false;
                        let hunkStartLine = -1; // Store the actual start line of the hunk

                        for (const line of lines) {
                            if (parseError) break;

                            const trimmedLine = line.trim();
                            let lineClass = '';
                            let displayLineNum = '';
                            let fileLineNumForThisLine = -1;

                            if (trimmedLine.startsWith('@@') && !hunkHeaderFound) {
                                hunkHeaderFound = true;
                                lineClass = 'hunk-header';
                                const match = trimmedLine.match(/^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
                                if (match && match[1]) {
                                    hunkStartLine = parseInt(match[1], 10); // Store hunk start line
                                    currentFileLineNum = hunkStartLine;
                                    displayLineNum = '...';
                                } else {
                                    console.error(\`FAILED to parse hunk header: "\${trimmedLine}"\`);
                                    parseError = true;
                                    styledLinesHtml = \`<span>Error parsing diff hunk header.</span>\`;
                                }
                                continue;
                            }

                            if (!hunkHeaderFound || currentFileLineNum === -1) continue;

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
                                if (line.length > 0) {
                                     fileLineNumForThisLine = currentFileLineNum;
                                     currentFileLineNum++;
                                } else {
                                     fileLineNumForThisLine = -1; // Don't number or filter empty lines based on range
                                }
                            }

                            // --- MODIFIED Filter Logic ---
                            let keepLine = false;
                            // Keep Add(+) or Context( ) lines based on calculated file line number
                            if (fileLineNumForThisLine !== -1 && (lineClass === 'addition' || lineClass === 'context')) {
                                if (isSingleLineComment) {
                                    // For single lines, show line L and up to CONTEXT_LINES_BEFORE
                                    // Ensure lower bound doesn't go below actual hunk start
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
                            // Note: Still filtering out '-' lines from the snippet for simplicity

                            if (keepLine) {
                                displayLineNum = String(fileLineNumForThisLine); // Use the calculated file line number
                                const escapedLine = escapeHtml(line);
                                styledLinesHtml += \`<span class="line \${lineClass}">\` +
                                                       \`<span class="line-num">\${displayLineNum}</span>\` +
                                                       \`<span class="line-content \${lineClass}">\${escapedLine}</span>\` +
                                                   \`</span>\`; // No trailing \\n
                            }
                        } // End for loop

                        if (styledLinesHtml && !parseError) {
                           filteredHunkHtml = \`<div class="diff-hunk"><pre><code>\${styledLinesHtml}</code></pre></div>\`;
                        } else if (parseError) {
                            filteredHunkHtml = \`<div class="diff-hunk"><pre><code>\${styledLinesHtml}</code></pre></div>\`;
                        }

                    } // End if(diffHunk...)

                    if (!commentBody && !filteredHunkHtml) return '';

                    let lineRangeString = '';
                    if (commentStartLine !== null && commentEndLine !== null && commentStartLine !== commentEndLine) {
                        lineRangeString = \`<span class="line-range"> lines \${commentStartLine} to \${commentEndLine}</span>\`;
                    } else if (commentEndLine !== null) {
                        lineRangeString = \`<span class="line-range"> line \${commentEndLine}</span>\`;
                    }

                    return \`<div class="timeline-item nested-review-comment-item" style="margin-left: 20px; margin-top: 10px; border-top: 1px dashed var(--vscode-editorWidget-border, #666); padding-top: 10px;">
                                <div class="item-header" style="font-size: 0.95em;">
                                     \${user ? \`<img class="avatar" src="\${user.avatar_url || ''}" alt="\${escapeHtml(user?.login || 'unknown user')}" width="18" height="18">\`: '<span class="avatar-placeholder" style="width:18px; height:18px;"></span>'}
                                    <strong class="author">\${escapeHtml(user?.login || 'unknown user')}</strong> commented on
                                    \${comment.path ? \`<span class="file-path" style="font-size: 0.9em;">\${escapeHtml(comment.path)}</span>\` : ''}
                                    \${lineRangeString}
                                    \${comment.html_url ? \`<a class="gh-link" href="\${comment.html_url}" title="View comment on GitHub" target="_blank">🔗</a>\` : ''}
                                    <span class="timestamp" style="font-size: 0.9em;">\${createdAt}</span>
                                </div>
                                \${filteredHunkHtml}
                                \${commentBody}
                            </div>\`;
                }
                 

                // --- HTML Generation Functions (REVISED with null checks and correct body_html usage) ---
                function generateReviewHtml(review) {
                    // 'review' object might contain 'associated_comments' array from fetchPrTimelineData

                    const associatedComments = review.associated_comments || []; // Get attached comments or empty array

                    // --- Basic Review Info ---
                    const stateFormatted = formatReviewState(review.state);
                    const stateClass = review.state?.toLowerCase() || 'commented';
                    const user = review.user;
                    const submittedAt = review.submitted_at ? new Date(review.submitted_at).toLocaleString() : '';

                    // --- Generate Body & Check if Renderable ---
                    // Use the helper for the main review submission body (handles fallback)
                    const reviewBody = generateCommentBodyHtml(review);

                    // Determine if this review event is significant enough to render even if empty
                    // (e.g., an explicit Approval or Change Request is meaningful)
                    const hasMeaningfulState = review.state && review.state !== 'COMMENTED';

                    // Skip rendering if it's just an empty 'COMMENTED' review event with no associated comments attached
                    if (!reviewBody && !hasMeaningfulState && associatedComments.length === 0) {
                         console.log(\`Skipping review submission #\${review.id} as it's empty and has no comments.\`);
                         return ''; // Return empty string to render nothing
                    }
                    // --- End Check ---

                    // --- Generate HTML for Associated Comments ---
                    let commentsHtml = '';
                    if (associatedComments.length > 0) {
                        // Use map() to call generateNestedReviewCommentHtml for each comment and join the results
                        commentsHtml = associatedComments.map(comment => generateNestedReviewCommentHtml(comment)).join('');
                    }
                    // --- End Generating Comments HTML ---

                    // --- Construct Final HTML for the Review Submission ---
                    return \`<div class="timeline-item review-submission-item">
                                <div class="item-header">
                                    \${user ? \`<img class="avatar" src="\${user.avatar_url || ''}" alt="\${escapeHtml(user?.login || 'unknown user')}" width="20" height="20">\`: '<span class="avatar-placeholder"></span>'}
                                    <strong class="author">\${escapeHtml(user?.login || 'unknown user')}</strong>
                                    <span class="review-state \${stateClass}">\${stateFormatted}</span>
                                    \${review.html_url ? \`<a class="gh-link" href="\${review.html_url}" title="View review on GitHub" target="_blank">🔗</a>\` : ''}
                                    <span class="timestamp">\${submittedAt}</span>
                                </div>
                                \${reviewBody} {/* Render the main body of the review submission itself */}
                                \${commentsHtml} {/* Render the nested HTML for all associated comments */}
                            </div>\`;
                }

                function generateReviewCommentHtml(comment) {
                    const user = comment.user;
                    const createdAt = comment.created_at ? new Date(comment.created_at).toLocaleString() : '';
                    const diffHunkHtml = (comment.diff_hunk && comment.diff_hunk.trim() !== '') ? \`<div class="diff-hunk"><pre><code>\${escapeHtml(comment.diff_hunk)}</code></pre></div>\` : ''; // Diff hunk IS plain text, escape it
                    
                    // Use the helper for the comment body
                    const commentBody = generateCommentBodyHtml(comment); // Use helper here

                     // Don't render if no body and no diff hunk
                     if (!commentBody && !diffHunkHtml) return '';

                    return \`<div class="timeline-item review-comment-item">
                                <div class="item-header">
                                     \${user ? \`<img class="avatar" src="\${user.avatar_url || ''}" alt="\${escapeHtml(user.login || '')}" width="20" height="20">\`: '<span class="avatar-placeholder"></span>'}
                                    <strong class="author">\${escapeHtml(user?.login || 'unknown user')}</strong> commented on
                                    \${comment.path ? \`<span class="file-path">\${escapeHtml(comment.path)}</span>\` : ''}
                                    \${comment.html_url ? \`<a class="gh-link" href="\${comment.html_url}" title="View on GitHub" target="_blank">🔗</a>\` : ''}
                                    <span class="timestamp">\${createdAt}</span>
                                </div>
                                \${diffHunkHtml}
                                \${commentBody}
                            </div>\`;
                }

                function generateIssueCommentHtml(comment) {
                     const user = comment.user;
                     const createdAt = comment.created_at ? new Date(comment.created_at).toLocaleString() : '';
                     // Use the helper for the comment body
                     const commentBody = generateCommentBodyHtml(comment); // Use helper here

                     // Don't render if no body
                     if (!commentBody) return '';

                    return \`<div class="timeline-item issue-comment-item">
                                <div class="item-header">
                                    \${user ? \`<img class="avatar" src="\${user.avatar_url || ''}" alt="\${escapeHtml(user.login || '')}" width="20" height="20">\`: '<span class="avatar-placeholder"></span>'}
                                    <strong class="author">\${escapeHtml(user?.login || 'unknown user')}</strong> commented
                                    \${comment.html_url ? \`<a class="gh-link" href="\${comment.html_url}" title="View on GitHub" target="_blank">🔗</a>\` : ''}
                                    <span class="timestamp">\${createdAt}</span>
                                </div>
                                \${commentBody}
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

                // Function to parse diff hunks and add styling WITH LINE NUMBERS (Corrected)
                function parseAndStyleDiffHunks() {
                    // console.log("Running parseAndStyleDiffHunks..."); // Keep logs if needed
                    if (!timelineContainer) {
                        console.error("Timeline container not found!");
                        return;
                    }
                    timelineContainer.querySelectorAll('.diff-hunk pre code').forEach((block, blockIndex) => {
                        if(block.dataset.styled) return;
                        // console.log(\`Processing diff block \${blockIndex}\`);

                        const lines = String(block.textContent || '').split('\\n'); // Use double backslash for JS string literal
                        let styledLinesHtml = '';
                        let currentLineNum = -1;
                        let hunkHeaderFound = false;
                        let startLineFromHeader = -1;

                        lines.forEach((line, lineIndex) => {
                            let lineClass = '';
                            let displayLineNum = '';
                            const trimmedLine = line.trim();

                            if (trimmedLine.startsWith('@@') && !hunkHeaderFound) {
                                hunkHeaderFound = true;
                                lineClass = 'hunk-header';
                                // console.log(\`  Line \${lineIndex}: Hunk header found: "\${line}" (Trimmed: "\${trimmedLine}")\`);

                                // Regex with escaped backslashes for \d
                                const match = trimmedLine.match(/^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);

                                // console.log("    -> Regex Match Result:", match); // Keep log if needed

                                if (match && match[1]) {
                                    startLineFromHeader = parseInt(match[1], 10);
                                    currentLineNum = startLineFromHeader;
                                    displayLineNum = '...';
                                    // console.log(\`    -> SUCCESS: Parsed start line: \${startLineFromHeader}\`);
                                } else {
                                    // console.error(\`    -> FAILED: Could not extract start line from header (trimmed): "\${trimmedLine}"\`);
                                    currentLineNum = -1;
                                    displayLineNum = 'ERR';
                                }
                            } else if (trimmedLine.startsWith('+')) {
                                lineClass = 'addition';
                                if (hunkHeaderFound && currentLineNum !== -1) {
                                    displayLineNum = String(currentLineNum);
                                    currentLineNum++;
                                } else { displayLineNum = '?'; }
                            } else if (trimmedLine.startsWith('-')) {
                                lineClass = 'deletion';
                                displayLineNum = ' ';
                            } else {
                                lineClass = 'context';
                                if (hunkHeaderFound && currentLineNum !== -1 && line.length > 0) {
                                    displayLineNum = String(currentLineNum);
                                    currentLineNum++;
                                } else {
                                    displayLineNum = ' ';
                                }
                            }

                            // Escape the actual code line content for safe HTML insertion
                            const escapedLine = escapeHtml(line);

                            // Ensure \${escapedLine} performs variable substitution correctly
                            styledLinesHtml += \`<span class="line \${lineClass}">\` +
                                                \`<span class="line-num">\${displayLineNum}</span>\` +
                                                \`<span class="line-content \${lineClass}">\${escapedLine}</span>\` + // <-- Corrected this line
                                            \`</span>\`; // Use escaped newline for JS string literal

                        });

                        block.innerHTML = styledLinesHtml;
                        block.dataset.styled = 'true';
                        // console.log(\`Finished processing block \${blockIndex}. Started at line \${startLineFromHeader}.\`);
                    });
                    // console.log("Finished parseAndStyleDiffHunks.");
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
                    // try {
                    //      parseAndStyleDiffHunks(); // Style diffs after inserting into DOM
                    // } catch(e) {
                    //      console.error("Error styling diff hunks:", e);
                    // }
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