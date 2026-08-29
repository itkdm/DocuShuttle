export type ApprovalSubmissionGate = {
  claim: (key: string) => boolean;
  release: (key: string) => void;
};

export function createApprovalSubmissionGate(): ApprovalSubmissionGate {
  let activeKey: string | undefined;
  return {
    claim: (key) => {
      if (activeKey) return false;
      activeKey = key;
      return true;
    },
    release: (key) => {
      if (activeKey === key) activeKey = undefined;
    },
  };
}
