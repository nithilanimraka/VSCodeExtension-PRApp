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

// --- Export Types needed by webview/main.ts ---
// If webview/main.ts imports types from here or a shared file, ensure they are exported
export type { TimelineItem }; // Export the main timeline type
// Export PullRequestInfo if needed, or ensure it's defined in prDataProvider and exported from there
// export type { PullRequestInfo }; // Already imported/exported via prDataProvider



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
    const panelId = prInfo.number;

    const existingActiveWebview = activePrDetailPanels.get(panelId);
    if (existingActiveWebview) {
        existingActiveWebview.panel.reveal(column);
        // Optional: Trigger a refresh even if revealing existing
        // await updateWebviewContent(context, existingActiveWebview.panel.webview, prInfo);
        return;
    }

    // Create a new panel.
    const panel = vscode.window.createWebviewPanel(
        'prDetailView', // View type
        `PR #${prInfo.number}`, // Panel title
        column || vscode.ViewColumn.One,
        {
            enableScripts: true, // Keep scripts enabled
            // --- IMPORTANT: Update localResourceRoots ---
            // Allow loading from the extension's root directory (covers 'dist', 'media', etc.)
            localResourceRoots: [
                context.extensionUri, // Allows access to root (including 'dist')
            ],
            // --- End Update ---
             retainContextWhenHidden: true
        }
    );
    panel.title = `PR #${prInfo.number}: ${prInfo.title}`; // Set full title

    const activeWebview: ActivePrWebview = { panel, prInfo, lastCommentCheckTime: new Date() };
    activePrDetailPanels.set(panelId, activeWebview);

    // Set initial HTML and trigger data load + postMessage
    // This function handles both setting HTML and sending initial data now
    await updateWebviewContent(context, panel.webview, prInfo);

    // Handle messages received FROM the webview
    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'alert': // Example command
                    vscode.window.showErrorMessage(message.text);
                    return;
                 case 'webviewReady': // Received when webview script finishes initializing
                     console.log(`Webview for PR #${prInfo.number} is ready.`);
                     // If initial data wasn't sent via updateWebviewContent, you could send it here.
                     // Example: sendDataToWebview(panel.webview, activeWebview.currentTimeline ?? []);
                     return;
                 // Add more cases here if the webview needs to send other messages
            }
        },
        undefined,
        context.subscriptions
    );

    // Clean up when panel is closed
    panel.onDidDispose(
        () => {
            activePrDetailPanels.delete(panelId);
            stopPollingIfNecessary();
        },
        null,
        context.subscriptions
    );

    startPollingIfNotRunning();
}

// =================================
// WEBVIEW CONTENT UPDATE
// =================================
async function updateWebviewContent(context: vscode.ExtensionContext, webview: vscode.Webview, prInfo: PullRequestInfo) {
    const octokit = await getOctokit();
    if (!octokit) {
        console.error("Octokit not available for updating webview content");
        // Display error in webview if Octokit fails
        webview.html = await getWebviewTimelineHtml(context, webview, prInfo); // Set basic HTML first
        webview.postMessage({ command: 'showError', message: 'Error: Cannot connect to GitHub.' }); // Send error message
        return;
    }

    // 1. Generate the Icon URI *before* setting HTML
    const commitIconUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'icons_svg', 'commit.svg'));
    console.log(`DEBUG: Commit Icon URI generated for postMessage: ${commitIconUri.toString()}`);

    // 2. Set initial static HTML (still needed to load the script)
    // Pass prInfo to getWebviewTimelineHtml; it no longer needs the icon URI itself.
    webview.html = await getWebviewTimelineHtml(context, webview, prInfo);

    // 3. Fetch dynamic data
    console.log(`Workspaceing timeline data for PR #${prInfo.number} to send to webview...`);
    let timelineItems: TimelineItem[] = [];
    try {
        timelineItems = await fetchPrTimelineData(octokit, prInfo);
    } catch (fetchError) {
         console.error(`Error fetching timeline data for PR #${prInfo.number}:`, fetchError);
         webview.postMessage({ command: 'showError', message: `Error fetching timeline: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}` });
         return;
    }

    // 4. Send data AND the icon URI to the loaded webview script
    console.log(`Sending <span class="math-inline">${timelineItems.length} timeline items and icon URI to webview for PR #</span>${prInfo.number}`);
    webview.postMessage({
        command: 'loadTimeline',
        data: timelineItems,
        // --- ADD ICON URI TO PAYLOAD ---
        iconUri: commitIconUri.toString()
    });

    // 5. Update internal state for polling etc.
    const activeWebview = activePrDetailPanels.get(prInfo.number);
    if (activeWebview) {
        activeWebview.prInfo = prInfo;
        activeWebview.currentTimeline = timelineItems;
    }
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
        //     // Log bot comments or any comment potentially missing body_html
        //     if ((comment.user?.login === 'pr-respond-test[bot]') || !comment.body_html) { // Adjust condition if needed
        //         console.log(`Review Comment #${comment.id} by ${comment.user?.login}`);
        //         // Make sure these two lines are active:
        //         console.log(`  -> body_html: ${comment.body_html}`);
        //         console.log(`  -> body: ${comment.body}`);
        //         // console.log(comment); // Optional: Log the whole object
        //     }
        // });
        // console.log("--- Raw Issue Comments Data ---");
        // issueCommentsResponse.data.forEach(comment => {
        //      // Log bot comments or any comment potentially missing body_html
        //      if ((comment.user?.login === 'pr-respond-test[bot]') || !comment.body_html) { // Adjust condition if needed
        //         console.log(`Issue Comment #${comment.id} by ${comment.user?.login}`);
        //         // Make sure these two lines are active:
        //         console.log(`  -> body_html: ${comment.body_html}`);
        //         console.log(`  -> body: ${comment.body}`);
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

// --- Define your CSS strings here or load from files ---

// Example placeholder for styles developed in previous steps
const commonStyles = `
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); padding: 15px 25px; }
    #timeline-area { margin-top: 20px; }
    #loading-indicator { padding: 10px; font-style: italic; opacity: 0.8; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    a:hover { text-decoration: underline; }
    hr { border: none; border-top: 1px solid var(--vscode-editorWidget-border, #444); margin: 15px 0; }
    code { font-family: var(--vscode-editor-font-family); font-size: calc(var(--vscode-editor-font-size) * 0.9); background-color: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-button-secondaryBackground); border-radius: 3px; padding: 0.1em 0.3em; }
    .timeline-item { margin-bottom: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-editorWidget-border, #444); }
    .timeline-item:first-child { border-top: none; padding-top: 0; }
    .item-header { margin-bottom: 8px; display: flex; align-items: center; gap: 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground); flex-wrap: wrap; }
    .item-header .author { font-weight: bold; color: var(--vscode-editor-foreground); }
    .timestamp { font-size: 0.9em; white-space: nowrap; opacity: 0.8; margin-left: auto; }
    .file-path { font-family: var(--vscode-editor-font-family); background-color: var(--vscode-textBlockQuote-background); padding: 1px 4px; border-radius: 3px; border: 1px solid var(--vscode-button-secondaryBackground); }
    .gh-link { margin-left: 5px; font-size: 0.9em; opacity: 0.7; }
    .gh-link:hover { opacity: 1; }
    .avatar { border-radius: 50%; vertical-align: middle; border: 1px solid var(--vscode-editorWidget-border, #444); width: 20px; height: 20px; }
    .avatar-placeholder { display: inline-block; width: 20px; height: 20px; background-color: var(--vscode-editorWidget-border); border-radius: 50%; vertical-align: middle; }
    .comment-body { padding: 5px 0; margin-left: 28px; margin-top: -5px; line-height: 1.4; }
    .comment-body p:first-child { margin-top: 0; }
    .comment-body p:last-child { margin-bottom: 0; }
    .review-state { font-weight: bold; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
    .review-state.approved { color: var(--vscode-gitDecoration-addedResourceForeground); background-color: rgba(47, 131, 47, 0.15); }
    .review-state.commented { color: var(--vscode-descriptionForeground); background-color: var(--vscode-textBlockQuote-background); }
    .review-state.changes_requested { color: var(--vscode-gitDecoration-modifiedResourceForeground); background-color: rgba(188, 76, 0, 0.15); }
    .review-state.dismissed { color: var(--vscode-descriptionForeground); background-color: var(--vscode-textBlockQuote-background); text-decoration: line-through; }
    .commit-item .item-header { gap: 5px; }
    .commit-message { margin-left: 28px; margin-top: -5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .commit-item code { font-size: 0.85em; }
    /* Add .line-range style */
    .line-range { opacity: 0.8; margin-left: 5px; font-size: 0.95em; }
`;

const markdownStyles = `
    .comment-body strong { font-weight: var(--vscode-markdown-bold-font-weight, bold); }
    .comment-body em { font-style: italic; }
    .comment-body blockquote { background: var(--vscode-textBlockQuote-background); border-left: 5px solid var(--vscode-textBlockQuote-border); margin: 5px 0 5px 5px; padding: 5px 10px; }
    .comment-body ul, .comment-body ol { margin-left: 25px; margin-top: 5px; margin-bottom: 5px; }
    .comment-body pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: var(--vscode-editor-line-height); background-color: var(--vscode-textBlockQuote-background); padding: 10px; border: 1px solid var(--vscode-editorWidget-border, #444); border-radius: 4px; overflow-x: auto; margin: 5px 0; }
    .comment-body :not(pre)>code { font-family: var(--vscode-editor-font-family); font-size: calc(var(--vscode-editor-font-size) * 0.9); background-color: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-button-secondaryBackground); border-radius: 3px; padding: 0.1em 0.3em; }
`;

const diffHunkStyles = `
    .diff-hunk { border: 1px solid var(--vscode-editorWidget-border, #ccc); border-radius: 4px; margin-bottom: 8px; overflow-x: auto; }
    .diff-hunk pre { margin: 0; padding: 0; background-color: var(--vscode-editor-background); border-radius: 4px; }
    .diff-hunk .line { display: flex; white-space: nowrap; margin: 0; padding: 0; }
    .diff-hunk .line-num { flex-shrink: 0; width: 45px; padding-right: 10px; text-align: right; opacity: 0.7; user-select: none; color: var(--vscode-editorLineNumber-foreground); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: var(--vscode-editor-line-height); margin: 0; padding: 0 10px 0 0; }
    .diff-hunk .line.hunk-header .line-num { opacity: 0.5; }
    .diff-hunk .line-content { flex-grow: 1; white-space: pre; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: var(--vscode-editor-line-height); margin: 0; padding-top: 0; padding-bottom: 0; border-left: 3px solid transparent; padding-left: 10px; }
    .diff-hunk .line-content.addition { background-color: rgba(47, 131, 47, 0.15); border-left-color: var(--vscode-gitDecoration-addedResourceForeground); }
    .diff-hunk .line-content.deletion { background-color: rgba(188, 76, 0, 0.15); border-left-color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .diff-hunk .line-content.hunk-header { color: var(--vscode-descriptionForeground); background-color: var(--vscode-textBlockQuote-background); padding: 2px 10px; font-style: italic; border-left: none; }
    .diff-hunk .line-content.context { /* Uses default transparent border */ }
`;

const commitStyles = `
    .timeline-item.commit-item {
    /* Reset some defaults if needed */
    padding-top: 8px; /* Less padding than comments? */
    padding-bottom: 8px;
    margin-bottom: 0; /* Make them appear closer together */
    border-top: 1px solid var(--vscode-editorWidget-border, #444);
    }
    .commit-item .item-header {
        display: flex;          /* Use flexbox for layout */
        align-items: center;    /* Align items vertically */
        gap: 8px;
        margin-bottom: 0;       /* Remove bottom margin */
        font-size: var(--vscode-font-size); /* Use standard font size */
        color: var(--vscode-editor-foreground); /* Standard text color */
        flex-wrap: nowrap;      /* Prevent wrapping */
    }
    /* Part containing author and message title */
    .commit-item .commit-info {
        flex-grow: 1;         /* Allow this part to take up space */
        display: flex;
        align-items: center;
        gap: 8px;
        overflow: hidden;     /* Hide overflow */
    }
    .commit-item .commit-info .author {
        font-weight: normal; /* Make author normal weight */
        flex-shrink: 0; /* Don't shrink author name */
    }
    .commit-item .commit-title {
        flex-grow: 1;          /* Allow title to take space */
        white-space: nowrap;   /* Prevent title wrap */
        overflow: hidden;      /* Hide overflow */
        text-overflow: ellipsis; /* Add '...' for overflow */
        opacity: 0.9;          /* Slightly dimmer than author? */
        margin-left: 5px;
    }
    /* Part containing SHA and timestamp */
    .commit-item .commit-meta {
        flex-shrink: 0;        /* Don't shrink this part */
        margin-left: auto;     /* Pushes it to the right */
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 0.9em;      /* Smaller font for meta */
        color: var(--vscode-descriptionForeground); /* Dimmer color */
    }
    .commit-item .commit-meta .commit-sha a,
    .commit-item .commit-meta .commit-sha code {
        font-family: var(--vscode-editor-font-family); /* Monospace for SHA */
        font-size: inherit; /* Inherit smaller size */
        /* Ensure code styles don't override color */
        color: var(--vscode-textLink-foreground);
        background: none;
        border: none;
        padding: 0;
    }
    .commit-item .commit-meta .timestamp {
        white-space: nowrap;
        opacity: 1; /* Reset opacity if inherited */
        margin-left: 0; /* Reset margin */
        font-size: inherit; /* Inherit smaller size */
    }

    .commit-icon-wrapper {
               display: inline-block; /* Or flex-shrink: 0; if inside flex */
               width: 16px;
               height: 16px;
               margin-right: 5px; /* Space between icon and avatar */
               vertical-align: text-bottom; /* Align with text */
               /* Set the color using a theme variable - SVG fill="currentColor" will inherit this */
               color: var(--vscode-icon-foreground);
    }
    .commit-icon-wrapper svg {
        /* Ensure SVG fills the wrapper */
        display: block;
        width: 100%;
        height: 100%;
    }

]

    
`;

// =================================
// WEBVIEW HTML GENERATION
// =================================
// --- Simplified getWebviewTimelineHtml ---
async function getWebviewTimelineHtml(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    prInfo: PullRequestInfo
): Promise<string> {
    const nonce = getNonce(); // Assumes getNonce() is defined elsewhere

    // URI for the bundled webview script (ensure 'main.js' matches your esbuild output)
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.js'));

    // --- Get URI for Codicon CSS ---
    //const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    // --- End Get URI ---

    // Basic HTML structure
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource};">
        <title>PR #${prInfo.number}</title>
        <style nonce="${nonce}">
            /* Inject all necessary CSS rules here */
            ${commonStyles}
            ${markdownStyles}
            ${diffHunkStyles}
            ${commitStyles}
        </style>
    </head>
    <body>
        <h1><a href="${prInfo.url}" target="_blank">#${prInfo.number}: ${escapeHtml(prInfo.title)}</a></h1>
        <p>Author: ${escapeHtml(prInfo.author)}</p>
        <hr>
        <div id="timeline-area">
            <p id="loading-indicator">Loading timeline...</p>
        </div>
        <script nonce="${nonce}" src="${scriptUri}"></script>
    </body>
    </html>`;
}
// --- End Simplified getWebviewTimelineHtml ---


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