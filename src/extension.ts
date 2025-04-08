import * as vscode from 'vscode';
import { getGitHubSession, getOctokit } from './auth';
// Assuming PrDataProvider and PullRequestItem are exported from here
import { PrDataProvider, PullRequestItem } from './prDataProvider';
import { Octokit } from '@octokit/rest'; // Import Octokit type
import type { Endpoints } from "@octokit/types"; // Import types for response data
import type { PullRequestInfo } from './prDataProvider';
import { CreatePrViewProvider } from './createPrViewProvider'; 
import { getNonce, escapeHtml } from './utils'; 

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

    // --- Register Create PR View ---
    // Store the provider instance so the command can call it
    const createPrViewProvider = new CreatePrViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CreatePrViewProvider.viewType, createPrViewProvider)
    );

    // --- 2. Register Commands ---

    // Refresh Command
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.refreshPrView', () => {
        prDataProvider?.refresh();
        // Also potentially refresh open webviews?
        for (const activeWebview of activePrDetailPanels.values()) {
             updateWebviewContent(context, activeWebview.panel.webview, activeWebview.prInfo);
        }
    }));

    // Create Pull Request Command (Focuses the Create PR View & loads data)
    // Make sure this is the ONLY registration block for this command ID
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.createPullRequest', async () => {
        // 1. Focus the separate "Create PR" view. VS Code activates its provider if needed.
        await vscode.commands.executeCommand('yourCreatePrViewId.focus');

        // 2. Tell the CreatePrViewProvider instance to fetch initial Git data
        //    and send it to its webview to populate the form.
        await createPrViewProvider.prepareAndSendData();
    }));

    // Command for clicking a PR item in the Tree View (yourPrViewId)
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.viewPullRequest', (itemOrPrInfo: PullRequestItem | PullRequestInfo) => {
        // Determine the PR info (handle TreeItem or direct info)
        const prInfo = (itemOrPrInfo instanceof PullRequestItem) ? itemOrPrInfo.prInfo : itemOrPrInfo;
        // Assuming createOrShowPrDetailWebview is defined elsewhere in this file or imported
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
async function updateWebviewContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    prInfo: PullRequestInfo
) {
    // 1. Get Octokit instance
    const octokit = await getOctokit(); // Ensure this handles potential auth errors gracefully
    if (!octokit) {
        console.error("[updateWebviewContent] Octokit not available.");
        try {
            // Try setting basic HTML shell to display an error within the webview
            const initialHtml = await getWebviewTimelineHtml(context, webview, prInfo);
            webview.html = initialHtml;
            // Send an error message for the webview script to display
            webview.postMessage({ command: 'showError', message: 'Error: Could not connect to GitHub. Please check authentication.' });
        } catch (htmlError) {
            console.error("[updateWebviewContent] Error getting webview HTML shell while handling Octokit error:", htmlError);
            webview.html = "<html><body>Critical error initializing view. GitHub connection failed.</body></html>";
        }
        return; // Stop if Octokit isn't available
    }

    // 2. Set the initial static HTML structure immediately.
    // This HTML contains the <script> tag for the bundled webview code,
    // the <link> tag for codicon.css, basic styles, and a "Loading..." indicator.
    try {
        webview.html = await getWebviewTimelineHtml(context, webview, prInfo);
    } catch (htmlError) {
        console.error("[updateWebviewContent] Error setting initial webview HTML:", htmlError);
        // Display a fallback error directly in the webview
        webview.html = `<html><body>Error loading UI shell: ${escapeHtml(String(htmlError))}</body></html>`;
        return; // Stop if the basic HTML fails
    }


    // 3. Fetch the actual timeline data asynchronously.
    console.log(`[updateWebviewContent] Fetching timeline data for PR #${prInfo.number} to send to webview...`);
    let timelineItems: TimelineItem[] = []; // Default to empty array
    try {
        // fetchPrTimelineData should handle its internal errors and return [] on failure if possible
        timelineItems = await fetchPrTimelineData(octokit, prInfo);
    } catch (fetchError) {
         console.error(`[updateWebviewContent] Error fetching timeline data for PR #${prInfo.number}:`, fetchError);
         // Send an error message to the webview script
         webview.postMessage({ command: 'showError', message: `Error fetching timeline: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}` });
         // Keep timelineItems as empty array, but continue to update internal state if needed
    }


    // 4. Send the fetched data (or empty array on error) to the webview script.
    // The webview script's message listener will handle the 'loadTimeline' command.
    console.log(`[updateWebviewContent] Sending ${timelineItems.length} timeline items to webview for PR #${prInfo.number}`);
    webview.postMessage({
        command: 'loadTimeline',
        data: timelineItems
        // Note: We are no longer sending icon URI or SVG string here
    });

    // 5. Update the internally stored state for this webview (used for polling comparison).
    const activeWebview = activePrDetailPanels.get(prInfo.number);
    if (activeWebview) {
        activeWebview.prInfo = prInfo; // Update PR info (e.g., if title changed)
        activeWebview.currentTimeline = timelineItems; // Store the latest data
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

    // esbuild should place styles.css alongside main.js if specified as entry point
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'styles.css'));

    // --- Get URI for Codicon CSS ---
    const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    console.log(`DEBUG: Codicon CSS URI generated: ${codiconCssUri.toString()}`);
    // --- End Get URI ---

    // Basic HTML structure
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource};">
        <title>PR #${prInfo.number}</title>
        <link href="${codiconCssUri}" rel="stylesheet" />
        <link href="${stylesUri}" rel="stylesheet" />
        <style nonce="${nonce}">
            /* You can keep truly dynamic or absolutely essential base styles here if needed */
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



