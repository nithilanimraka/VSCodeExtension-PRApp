// Define types for Git info we might need
export interface GitInfo {
    headBranch?: string;
    baseBranch?: string;
    changedFiles?: ChangedFile[]; // Files changed (can be local changes or comparison result)

    // Common Info
    remoteUrl?: string;
    owner?: string;
    repo?: string;
    branches?: string[];
}

// Type for changed files (common)
export interface ChangedFile {
    path: string;
    status: 'A' | 'M' | 'D' | 'R' | 'C' | '?'; // Added, Modified, Deleted, Renamed, Copied, Untracked/Unknown
}

// Type for files returned by GitHub compare endpoint
export type ComparisonFile = {
    sha: string;
    filename: string;
    status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
    // Add other properties if needed (additions, deletions, etc.)
};


// --- Message Types for Create PR Webview ---

// Define the shape of messages sent TO the Create PR webview
export type ToCreatePrWebviewMessage =
    | { command: 'loadFormData'; data: GitInfo | Partial<GitInfo> }
    | { command: 'reviewFinished'; success: boolean }; // Optional: To re-enable button

// Define the shape of messages sent FROM the Create PR webview
export type FromCreatePrWebviewMessage =
    | { command: 'webviewReady' }
    | { command: 'createPrRequest'; data: { base: string; head: string; title: string; body: string; } }
    | { command: 'cancelPr' }
    | { command: 'getChangedFiles' }
    | { command: 'compareBranches'; base: string; head: string }
    | { command: 'showCreatePrDiff'; data: { base: string; head: string; filename: string; status: ChangedFile['status']; owner: string; repo: string } }
    // | { command: 'codeReviewRequest'; data: { base: string; head: string; } } // Can likely remove this if submitCodeReview handles all
    | { command: 'submitCodeReview'; data: { base: string; head: string; } } // Sends base/head to extension
    | { command: 'showError'; text: string };


// Common VSCode API interface (if not already defined elsewhere)
export interface VsCodeApi {
    postMessage(message: FromCreatePrWebviewMessage | any): void; // Use specific message type, allow 'any' for flexibility if needed
    getState(): any;
    setState(state: any): void;
}

// Interface for Review Data expected from backend /code-review endpoint
export interface ReviewItemData {
    fileName: string;
    codeSegmentToFix: string;
    start_line_with_prefix: string;
    end_line_with_prefix: string;
    language: string;
    issue: string; // Changed from 'comment' for clarity
    suggestion: string;
    suggestedCode?: string | null;
    severity: string; // Expecting 'error', 'warning', or 'info'
}

// Message type for sending data TO the Review Result webview
export type ToReviewResultWebviewMessage =
    | { command: 'showReviewResults'; data: ReviewItemData[] };

// Message type for receiving data FROM the Review Result webview
export type FromReviewResultWebviewMessage =
    | { command: 'webviewReady' }
    | { command: 'copyCode'; code: string }; // Example if you add interactions