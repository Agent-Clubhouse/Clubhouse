import type { ClubhouseAPI } from '../../preload/index';

declare global {
  interface Window {
    clubhouse: ClubhouseAPI;
  }
}
