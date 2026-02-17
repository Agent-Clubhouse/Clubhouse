/**
 * Shared module-level state for the issues plugin.
 *
 * SidebarPanel and MainPanel are rendered in separate React trees,
 * so we use a lightweight pub/sub to coordinate the selected issue.
 */

export interface IssueListItem {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string };
  labels: Array<{ name: string; color: string }>;
}

export interface IssueDetail extends IssueListItem {
  body: string;
  comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
  assignees: Array<{ login: string }>;
}

export const issueState = {
  selectedIssueNumber: null as number | null,
  creatingNew: false,
  issues: [] as IssueListItem[],
  page: 1,
  hasMore: false,
  loading: false,
  listeners: new Set<() => void>(),

  setSelectedIssue(num: number | null): void {
    this.selectedIssueNumber = num;
    this.creatingNew = false;
    this.notify();
  },

  setCreatingNew(val: boolean): void {
    this.creatingNew = val;
    if (val) this.selectedIssueNumber = null;
    this.notify();
  },

  setIssues(issues: IssueListItem[]): void {
    this.issues = issues;
    this.notify();
  },

  appendIssues(issues: IssueListItem[]): void {
    this.issues = [...this.issues, ...issues];
    this.notify();
  },

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.notify();
  },

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  },

  notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  },

  reset(): void {
    this.selectedIssueNumber = null;
    this.creatingNew = false;
    this.issues = [];
    this.page = 1;
    this.hasMore = false;
    this.loading = false;
    this.listeners.clear();
  },
};
