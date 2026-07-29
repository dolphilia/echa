export type ChatKeyInput = {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
};

export function shouldSendChatOnKeyDown(input: ChatKeyInput): boolean {
  return input.key === "Enter"
    && !input.shiftKey
    && !input.isComposing
    && input.keyCode !== 229;
}
