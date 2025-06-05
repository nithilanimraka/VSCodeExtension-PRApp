import * as vscode from 'vscode';
import { getOctokit } from './auth';
import { PrDataProvider } from './prDataProvider';
import { Octokit } from '@octokit/rest'; 
import type { Endpoints } from "@octokit/types"; 
import type { PullRequestInfo } from './prDataProvider';; 
import { getNonce, escapeHtml } from './utils'; 
import { createTempFile } from './extension';



// Type Definitions for GitHub API Responses 
type IssueComment = Endpoints["GET /repos/{owner}/{repo}/issues/{issue_number}/comments"]["response"]["data"][0];
type ReviewComment = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"]["response"]["data"][0];
type Review = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"]["response"]["data"][0];
type CommitListItem = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/commits"]["response"]["data"][0];
type ChangedFileFromApi = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/files"]["response"]["data"][0];

type FromWebviewMessage =
    | { command: 'webviewReady' }
    | { command: 'showError'; text: string }
    | { command: 'alert'; text: string }
    | { command: 'mergePr'; data: { merge_method: 'merge' | 'squash' | 'rebase' } }
    | { command: 'addComment'; text: string }
    | { command: 'closePr' }
    | { command: 'refreshThisPr' };

type MergeStatusUpdateData = {
    mergeable: boolean | null;
    mergeable_state: string;
};

interface PrDetails {
    timeline: TimelineItem[];
    mergeable_state: string; 
    mergeable: boolean | null;
    // Fields for the header display
    state: 'open' | 'closed';
    merged: boolean;
    authorLogin: string;
    authorAvatarUrl?: string | null;
    baseLabel: string; 
    headLabel: string; 
    body: string | null;
    createdAt: string; 
}

// Timeline Item Structure 
interface TimelineItemBase {
    timestamp: Date;
}
interface ReviewTimelineItem extends TimelineItemBase {
    type: 'review';
    // Associated comments directly to the data payload 
    data: Review & { associated_comments?: ReviewComment[] };
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

interface ChangedFile {
    path: string;
    status: 'A' | 'M' | 'D' | 'R' | 'C' | '?';
}

type TimelineItem = ReviewTimelineItem | ReviewCommentTimelineItem | IssueCommentTimelineItem | CommitTimelineItem;

export type { TimelineItem }; // Export the main timeline type


let prDataProvider: PrDataProvider | undefined;

interface ActivePrWebview {
    panel: vscode.WebviewPanel;
    prInfo: PullRequestInfo;
    lastCommentCheckTime?: Date; 
    currentTimeline?: TimelineItem[]; 
}
const activePrDetailPanels = new Map<number, ActivePrWebview>(); // Keyed by PR number
let pollingIntervalId: NodeJS.Timeout | undefined = undefined;
const POLLING_INTERVAL_MS = 30000; // Poll every 30 seconds

// WEBVIEW PANEL MANAGEMENT
export async function createOrShowPrDetailWebview(context: vscode.ExtensionContext, prInfo: PullRequestInfo, isNewlyCreated?: boolean) {
    const column = vscode.window.activeTextEditor?.viewColumn;
    const panelId = prInfo.number;

    const existingActiveWebview = activePrDetailPanels.get(panelId);
    if (existingActiveWebview) {
        existingActiveWebview.panel.reveal(column);
        existingActiveWebview.panel.title = `Pull Request #${prInfo.number}`;
        return;
    }

    const desiredPanelTitle = `Pull Request #${prInfo.number}`;    

    // Create a new panel.
    const panel = vscode.window.createWebviewPanel(
        'prDetailView', // View type
        desiredPanelTitle, // Title of the panel
        column || vscode.ViewColumn.One,
        {
            enableScripts: true, // Keep scripts enabled
            // Update localResourceRoots 
            // Allow loading from the extension's root directory 
            localResourceRoots: [
                context.extensionUri, // Allows access to root 
            ],
             retainContextWhenHidden: true
        }
    );
    panel.title = desiredPanelTitle;
    const webview = panel.webview; // Get webview reference

    const activeWebview: ActivePrWebview = { panel, prInfo, lastCommentCheckTime: new Date() };
    activePrDetailPanels.set(panelId, activeWebview);

    // Set initial HTML and trigger data load + postMessage
    // This function handles both setting HTML and sending initial data now
    await updateWebviewContent(context, panel.webview, prInfo);

    // Handle messages received from the webview
    panel.webview.onDidReceiveMessage(
        async (message: FromWebviewMessage) => { // Add type annotation
            const octokit = await getOctokit();
            const owner = prInfo.repoOwner;
            const repo = prInfo.repoName;
            const pull_number = prInfo.number;

            switch (message.command) {
                case 'refreshThisPr':
                     console.log(`Received refresh request for PR #${pull_number}`);
                     // Call the existing function to refetch and update content
                     // Pass the specific panel's webview reference
                     await updateWebviewContent(context, panel.webview, prInfo);
                     return;

                case 'alert':
                    vscode.window.showErrorMessage(message.text);
                    return;

                 case 'webviewReady':
                     console.log(`PR Detail Webview for #${prInfo.number} is ready.`);
                     return;

                 case 'mergePr':
                    if (!octokit) {
                        vscode.window.showErrorMessage("Cannot perform action: GitHub authentication required.");
                        return;
                    }
                    const mergeMethod = message.data?.merge_method || 'merge';
                    try {
                        vscode.window.showInformationMessage(`Attempting to merge PR #${pull_number} using '${mergeMethod}' method...`);
                        const response = await octokit.pulls.merge({
                            owner,
                            repo,
                            pull_number,
                            merge_method: mergeMethod, 
                        });
                        if (response.status === 200 && response.data.merged) {
                            vscode.window.showInformationMessage(`PR #${pull_number} merged successfully using '${mergeMethod}'!`);
                            // Refresh the webview to show merged state
                            await updateWebviewContent(context, panel.webview, prInfo);
                        } else {
                            vscode.window.showWarningMessage(`PR #${pull_number} could not be merged automatically. Status: ${response.status}. Message: ${response.data.message}`);
                            await updateWebviewContent(context, panel.webview, prInfo);
                        }
                    } catch (err: any) {
                        console.error(`Failed to merge PR #${pull_number}:`, err);
                        vscode.window.showErrorMessage(`Failed to merge PR: ${err.message || 'Unknown error'}`);
                        // Refresh to show current state again after failure
                        await updateWebviewContent(context, panel.webview, prInfo);
                    }
                    return; 

                 case 'addComment':
                    if (!octokit) {
                        vscode.window.showErrorMessage("Cannot perform action: GitHub authentication required.");
                        return;
                    }
                     try {
                         await octokit.issues.createComment({
                             owner,
                             repo,
                             issue_number: pull_number, // Use issue_number endpoint for general comments
                             body: message.text,
                         });
                         vscode.window.showInformationMessage(`Comment added to PR #${pull_number}.`);
                         await updateWebviewContent(context, panel.webview, prInfo);
                     } catch (err: any) {
                          console.error(`Failed to add comment to PR #${pull_number}:`, err);
                          vscode.window.showErrorMessage(`Failed to add comment: ${err.message || 'Unknown error'}`);
                     }
                     return; 

                 case 'closePr':
                    if (!octokit) {
                        vscode.window.showErrorMessage("Cannot perform action: GitHub authentication required.");
                        return;
                    }
                     try {
                          vscode.window.showInformationMessage(`Attempting to close PR #${pull_number}...`);
                          await octokit.pulls.update({
                              owner,
                              repo,
                              pull_number,
                              state: 'closed',
                          });
                          vscode.window.showInformationMessage(`PR #${pull_number} closed.`);
                          // Refresh the webview to show closed state
                          await updateWebviewContent(context, panel.webview, prInfo);
                     } catch (err: any) {
                           console.error(`Failed to close PR #${pull_number}:`, err);
                           vscode.window.showErrorMessage(`Failed to close PR: ${err.message || 'Unknown error'}`);
                           // Refresh to show current state again after failure
                           await updateWebviewContent(context, panel.webview, prInfo);
                     }
                     return; 
            }
        },
        undefined,
        context.subscriptions
    );

    startPollingIfNotRunning();

    // DELAYED REFRESH FOR NEW PRS 
    if (isNewlyCreated) {
        const refreshDelayMs = 3000;
        console.log(`PR #${prInfo.number} is newly created. Scheduling status refresh in ${refreshDelayMs}ms.`);

        setTimeout(async () => {
            const currentPanelInfo = activePrDetailPanels.get(prInfo.number);
            // Check if panel still exists and belongs to this PR
            if (currentPanelInfo && currentPanelInfo.panel === panel) {
                const octokit = await getOctokit(); // Get octokit instance again
                if (octokit) {
                    console.log(`Refreshing MERGE STATUS for newly created PR #${prInfo.number}...`);
                    await fetchAndUpdateMergeStatus(octokit, prInfo, webview);
                } else {
                     console.warn("Cannot refresh merge status: Octokit not available.");
                }
            } else {
                 console.log(`Panel for newly created PR #${prInfo.number} no longer active or changed before refresh could run.`);
            }
        }, refreshDelayMs);
    }

    // Clean up when panel is closed
    panel.onDidDispose(
        () => {
            console.log(`Panel for PR #${prInfo.number} disposed.`);
            activePrDetailPanels.delete(panelId);
            stopPollingIfNecessary();
        },
        null,
        context.subscriptions
    );
}

// WEBVIEW CONTENT UPDATE
export async function updateWebviewContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    prInfo: PullRequestInfo
) {
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
        return; 
    }

    // Set the initial static HTML structure immediately.
    try {
        webview.html = await getWebviewTimelineHtml(context, webview, prInfo);
    } catch (htmlError) {
        console.error("[updateWebviewContent] Error setting initial webview HTML:", htmlError);
        // Display a fallback error directly in the webview
        webview.html = `<html><body>Error loading UI shell: ${escapeHtml(String(htmlError))}</body></html>`;
        return; // Stop if the basic HTML fails
    }


    // Fetch the actual timeline data asynchronously.
    console.log(`[updateWebviewContent] Fetching full details for PR #${prInfo.number}...`);
    let prDetails: PrDetails | null = null;
    try {
        prDetails = await fetchPrFullDetails(octokit, prInfo);
    } catch (fetchError) {
         console.error(`[updateWebviewContent] Error fetching full details for PR #${prInfo.number}:`, fetchError);
         webview.postMessage({ command: 'showError', message: `Error fetching PR details: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}` });
    }


    // Send the fetched data (or empty array on error) to the webview script.
    // The webview script's message listener will handle the 'loadTimeline' command.
    if (prDetails) {
        console.log(`[updateWebviewContent] Sending details (timeline: ${prDetails.timeline.length}, mergeable: ${prDetails.mergeable_state}) to webview for PR #${prInfo.number}`);
        webview.postMessage({
            command: 'loadDetails',
            data: prDetails
        });
    } else {
         // Handle case where fetching details completely failed (error already shown)
         console.log(`[updateWebviewContent] Details fetch failed for PR #${prInfo.number}.`);
    }

    // Update internal state for polling (if applicable)
    const activeWebview = activePrDetailPanels.get(prInfo.number);
    if (activeWebview) {
        activeWebview.prInfo = prInfo;
        activeWebview.currentTimeline = prDetails?.timeline; // Update stored timeline
    }
}

export async function fetchPrFullDetails(octokit: Octokit, prInfo: PullRequestInfo): Promise<PrDetails | null> {
    const owner = prInfo.repoOwner;
    const repo = prInfo.repoName;
    const pull_number = prInfo.number;

    try {
        // Get core PR data including mergeability
        // We still need this for merge status and potentially other actions
        const { data: pullData } = await octokit.pulls.get({ owner, repo, pull_number });

        // Get Timeline Data
        const timeline = await fetchPrTimelineData(octokit, prInfo);

        return {
            timeline: timeline,
            mergeable_state: pullData.mergeable_state,
            mergeable: pullData.mergeable,
            state: pullData.state as ('open' | 'closed'), // Add type assertion
            merged: pullData.merged || false, // Ensure boolean
            authorLogin: pullData.user?.login || 'unknown',
            authorAvatarUrl: pullData.user?.avatar_url,
            baseLabel: pullData.base?.label || 'unknown',
            headLabel: pullData.head?.label || 'unknown',
            body: pullData.body, // body
            createdAt: pullData.created_at, // creation date
        };

    } catch (error) {
        console.error(`Failed to fetch details for PR #${pull_number}:`, error);
        vscode.window.showErrorMessage(`Failed to fetch PR details: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}


// DATA FETCHING FOR TIMELINE
export async function fetchPrTimelineData(octokit: Octokit, prInfo: PullRequestInfo): Promise<TimelineItem[]> {
    try {
        const owner = prInfo.repoOwner;
        const repo = prInfo.repoName;
        const pull_number = prInfo.number;

        console.log(`Workspaceing timeline data for PR #${pull_number}`);

        const [reviewsResponse, reviewCommentsResponse, issueCommentsResponse, commitsResponse] = await Promise.all([
            octokit.pulls.listReviews({ owner, repo, pull_number, per_page: 100 }), 
            octokit.pulls.listReviewComments({ owner, repo, pull_number, per_page: 100 }),
            octokit.issues.listComments({ owner, repo, issue_number: pull_number, per_page: 100 }),
            octokit.pulls.listCommits({ owner, repo, pull_number, per_page: 100 })
        ]);

        // Create a Map of Review Comments by Review ID
        const commentsByReviewId = new Map<number, ReviewComment[]>();
        reviewCommentsResponse.data.forEach(comment => {
            if (comment.pull_request_review_id) {
                const comments = commentsByReviewId.get(comment.pull_request_review_id) || [];
                comments.push(comment);
                commentsByReviewId.set(comment.pull_request_review_id, comments);
            }
        });
        console.log(`Mapped ${commentsByReviewId.size} reviews with associated comments.`);


        // Initialize Timeline Items 
        let timelineItems: TimelineItem[] = [];

        // Process Reviews and Attach Comments 
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

        //  Process Other Timeline Items (Review Comments, Issue Comments, Commits) 

        // Add standalone review comments (these should ideally be filtered later)
        reviewCommentsResponse.data.forEach(item => timelineItems.push({ type: 'review_comment', data: item, timestamp: new Date(item.created_at) }));
        // Add issue comments
        issueCommentsResponse.data.forEach(item => timelineItems.push({ type: 'issue_comment', data: item, timestamp: new Date(item.created_at) }));
        // Add commits
        commitsResponse.data.forEach(item => {
             if(item.commit.author?.date) {
                 timelineItems.push({ type: 'commit', data: item, timestamp: new Date(item.commit.author.date) });
             }
        });



        // Re-enable the Filter 
        // Filter out standalone review comments that BELONG to a fetched review submission
        const submittedReviewIds = new Set(reviewsResponse.data.map(r => r.id));
        const originalCount = timelineItems.length; 
        timelineItems = timelineItems.filter(item =>
            !(item.type === 'review_comment' && item.data.pull_request_review_id && submittedReviewIds.has(item.data.pull_request_review_id))
        );
        console.log(`Filtered out ${originalCount - timelineItems.length} standalone review comments associated with fetched reviews.`);


        // Sort the Final Timeline 
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
        return []; 
    }
}

// POLLING LOGIC
export function startPollingIfNotRunning() {
    if (!pollingIntervalId && activePrDetailPanels.size > 0) {
        console.log("Starting PR timeline polling...");
        pollingIntervalId = setInterval(pollForUpdates, POLLING_INTERVAL_MS);
    }
}

export function stopPollingIfNecessary() {
    if (pollingIntervalId && activePrDetailPanels.size === 0) {
        console.log("Stopping PR timeline polling.");
        clearInterval(pollingIntervalId);
        pollingIntervalId = undefined;
    }
}

export async function pollForUpdates() {
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

        try {
            const prInfo = activeWebview.prInfo;
            const newTimeline = await fetchPrTimelineData(octokit, prInfo);

            // Check if the timeline has changed
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
             activeWebview.lastCommentCheckTime = new Date(); 

        } catch (error) {
            console.error(`Error polling timeline for PR #${activeWebview.prInfo.number}:`, error);
        }
    });

    await Promise.all(updateChecks);
    console.log("Polling cycle finished.");
}

export async function fetchAndUpdateMergeStatus(
    octokit: Octokit, // Pass octokit instance
    prInfo: PullRequestInfo,
    webview: vscode.Webview // Pass the specific webview to update
) {
    console.log(`Workspaceing merge status update for PR #${prInfo.number}...`);
    try {
        const { data: pullData } = await octokit.pulls.get({
            owner: prInfo.repoOwner,
            repo: prInfo.repoName,
            pull_number: prInfo.number,
        });

        webview.postMessage({
            command: 'updateMergeStatus', 
            data: {
                mergeable: pullData.mergeable,
                mergeable_state: pullData.mergeable_state,
            } as MergeStatusUpdateData 
        });
        console.log(`Sent merge status update for PR #${prInfo.number}: ${pullData.mergeable_state}`);

    } catch (error) {
        console.error(`Failed to fetch merge status update for PR #${prInfo.number}:`, error);
    }
}


// DIFF VIEW LOGIC
export async function fetchAndShowDiffForFile(context: vscode.ExtensionContext, prInfo: PullRequestInfo, file: ChangedFileFromApi ) {
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

            progress.report({ message: `Processing ${file.filename}...` });
            const filename = file.filename; // Use filename from input 'file'

            // Use file.status from input 'file'
            if (file.status === 'added') {
                try {
                    const { data: contentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: filename, ref: headSha });
                    const headContent = Buffer.from((contentData as any).content, 'base64').toString('utf8');
                    const baseUri = await createTempFile(context, `<span class="math-inline">\{prInfo\.number\}\-</span>{baseSha}-EMPTY-${filename}`, '');
                    const headUri = await createTempFile(context, `<span class="math-inline">\{prInfo\.number\}\-</span>{headSha}-${filename}`, headContent);
                    const diffTitle = `${filename} (Added in PR #${prInfo.number})`;
                    vscode.commands.executeCommand('vscode.diff', baseUri, headUri, diffTitle);
                } catch (err) { handleDiffError(err, filename); }

            } else if (file.status === 'removed') {
                try {
                    const { data: contentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: filename, ref: baseSha });
                    const baseContent = Buffer.from((contentData as any).content, 'base64').toString('utf8');
                    const baseUri = await createTempFile(context, `<span class="math-inline">\{prInfo\.number\}\-</span>{baseSha}-${filename}`, baseContent);
                    const headUri = await createTempFile(context, `<span class="math-inline">\{prInfo\.number\}\-</span>{headSha}-REMOVED-${filename}`, '');
                    const diffTitle = `${filename} (Removed in PR #${prInfo.number})`;
                    vscode.commands.executeCommand('vscode.diff', baseUri, headUri, diffTitle);
                } catch (err) { handleDiffError(err, filename); }

            } else { // Modified, renamed etc.
                try {
                    const { data: baseContentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: filename, ref: baseSha });
                    const { data: headContentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: filename, ref: headSha });
                    const baseContent = Buffer.from((baseContentData as any).content, 'base64').toString('utf8');
                    const headContent = Buffer.from((headContentData as any).content, 'base64').toString('utf8');
                    const baseUri = await createTempFile(context, `<span class="math-inline">\{prInfo\.number\}\-</span>{baseSha}-${filename}`, baseContent);
                    const headUri = await createTempFile(context, `<span class="math-inline">\{prInfo\.number\}\-</span>{headSha}-${filename}`, headContent);
                    const diffTitle = `${filename} (Changes in PR ${prInfo.number})`;
                    vscode.commands.executeCommand('vscode.diff', baseUri, headUri, diffTitle);
                } catch (err) { handleDiffError(err, filename); }
            }
        
         }); 

     } catch (err) { 
        console.error("Error in fetchAndShowDiff:", err);
        if(err instanceof Error) {
           vscode.window.showErrorMessage(`Failed to show diff: ${err.message}`);
        } else {
            vscode.window.showErrorMessage(`Failed to show diff: ${String(err)}`);
        }
     }
}

export async function showDiffBetweenBranches(
    context: vscode.ExtensionContext, 
    owner: string,
    repo: string,
    baseBranch: string,
    headBranch: string,
    filename: string,
    status: ChangedFile['status'] // Receive status from webview
) { 
    console.log(`Showing diff for ${filename} between <span class="math-inline">\{baseBranch\}\.\.\.</span>{headBranch}`);
    const octokit = await getOctokit();
    if (!octokit) { vscode.window.showErrorMessage("Please sign in to GitHub first."); return; }

    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Workspaceing Diff for ${filename}...`, cancellable: false }, async (progress) => {

            let baseContent = '';
            let headContent = '';
            let diffTitle = `<span class="math-inline">\{filename\} \(</span>{baseBranch}...${headBranch})`;
            let baseUri: vscode.Uri | undefined;
            let headUri: vscode.Uri | undefined;

            progress.report({ message: `Workspaceing base content (${baseBranch})...` });
            // Fetch base content unless file was added
            if (status !== 'A') { // Changed 'added' to 'A'
                try {
                    const { data: baseData } = await octokit.repos.getContent({ owner, repo, path: filename, ref: baseBranch });
                    baseContent = Buffer.from((baseData as any).content, 'base64').toString('utf8');
                } catch (err: any) {
                     // If file not found on base, treat as added 
                    if (err.status === 404) {
                        console.warn(`File ${filename} not found on base branch ${baseBranch}, treating as added.`);
                        status = 'A'; // Adjust status based on fetch result
                    } else {
                        throw err; // Re-throw other errors
                    }
                }
            }

            progress.report({ message: `Workspaceing head content (${headBranch})...` });
             // Fetch head content unless file was removed
             if (status !== 'D') { // Changed 'removed' to 'D'
                try {
                     const { data: headData } = await octokit.repos.getContent({ owner, repo, path: filename, ref: headBranch });
                     headContent = Buffer.from((headData as any).content, 'base64').toString('utf8');
                } catch (err: any) {
                     // If file not found on head, treat as removed
                     if (err.status === 404) {
                         console.warn(`File ${filename} not found on head branch ${headBranch}, treating as removed.`);
                         status = 'D'; // Adjust status based on fetch result
                     } else {
                         throw err; // Re-throw other errors
                     }
                }
             }


            // Create Temp Files based on adjusted status
             progress.report({ message: `Creating temp files...` });
            if (status === 'A') { // Added
                baseUri = await createTempFile(context, `<span class="math-inline">\{uniquePrefix\}\-EMPTY\-</span>{filename}`, ''); // Empty base
                headUri = await createTempFile(context, `<span class="math-inline">\{uniquePrefix\}\-</span>{headBranch}-${filename}`, headContent);
                diffTitle = `${filename} (Added in ${headBranch} vs ${baseBranch})`;
            } else if (status === 'D') { // Removed
                baseUri = await createTempFile(context, `<span class="math-inline">\{uniquePrefix\}\-</span>{baseBranch}-${filename}`, baseContent);
                headUri = await createTempFile(context, `<span class="math-inline">\{uniquePrefix\}\-EMPTY\-</span>{filename}`, ''); // Empty head
                diffTitle = `${filename} (Removed in ${headBranch} vs ${baseBranch})`;
            } else { // Modified, Renamed, Copied
                 baseUri = await createTempFile(context, `<span class="math-inline">\{uniquePrefix\}\-</span>{baseBranch}-${filename}`, baseContent);
                 headUri = await createTempFile(context, `<span class="math-inline">\{uniquePrefix\}\-</span>{headBranch}-${filename}`, headContent);
                 diffTitle = `${filename} (Modified in ${headBranch} vs ${baseBranch})`;
            }

            // Show diff
            if (baseUri && headUri) {
                vscode.commands.executeCommand('vscode.diff', baseUri, headUri, diffTitle);
            } else {
                 throw new Error("Could not create URIs for diff view.");
            }
        });
    } catch (err) {
         console.error(`Error showing diff between branches for ${filename}:`, err);
         vscode.window.showErrorMessage(`Failed to show diff for ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
}


// Helper for specific diff errors
export function handleDiffError(err: any, filename: string) {
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

// WEBVIEW HTML GENERATION
export async function getWebviewTimelineHtml(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    prInfo: PullRequestInfo
): Promise<string> {
    const nonce = getNonce(); 

    // URI for the bundled webview script 
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.js'));

    // esbuild should place styles.css alongside main.js if specified as entry point
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'styles.css'));

    const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    console.log(`DEBUG: Codicon CSS URI generated: ${codiconCssUri.toString()}`);

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
        <div class="title-bar">
            <h1><a href="${prInfo.url}" target="_blank">#${prInfo.number}: ${escapeHtml(prInfo.title)}</a></h1>
            <button id="refresh-button" class="button icon-button" title="Refresh PR Details">
                    <span class="codicon codicon-refresh"></span>
            </button>
        </div>
        
        <div id="pr-metadata-header" class="pr-metadata-header">
             Loading details...
        </div>

        <hr class="status-timeline-separator">

        <div id="pr-status-area" class="pr-status-area">
            <div id="merge-status" class="status-section loading">Loading merge status...</div>

            <div class="merge-controls"> 
                 <div class="form-group"> 
                    <label for="merge-method-select">Merge Method:</label>
                    <select id="merge-method-select" name="merge-method-select">
                        <option value="merge">Create a merge commit</option>
                        <option value="squash">Squash and merge</option>
                        <option value="rebase">Rebase and merge</option>
                    </select>
                 </div>
                 <button id="confirm-merge-button" class="button merge-button" disabled> 
                    <span class="codicon codicon-git-merge"></span> Merge pull request
                 </button>
            </div>

        </div>

        <hr class="status-timeline-separator">

        <div id="pr-description-area" class="pr-description-area">
             Loading description...
        </div>

        <hr class="status-timeline-separator">

        <div id="timeline-area">
            <p id="loading-indicator">Loading timeline...</p>
        </div>

        <div id="comment-box-area" class="comment-box-area">
             <hr>
             <h3>Add a comment</h3>
             <textarea id="new-comment-text" placeholder="Add your comment here..."></textarea>
             <div class="comment-box-actions">
                 <button id="close-button" class="button secondary-button">
                      <span class="codicon codicon-git-pull-request-closed"></span> Close Pull Request
                 </button>
                 <button id="add-comment-button" class="button primary-button">
                      <span class="codicon codicon-comment"></span> Comment
                 </button>
            </div>
        </div>

        <script nonce="${nonce}" src="${scriptUri}"></script>
    </body>
    </html>`;
}