/**
 * The chats on screen, told to the chat worker so their model requests go first when requests wait for the
 * same runtime (src/harness/limit). A chat session registers itself while it is shown and unregisters when it
 * is hidden or closed.
 */
const shown = new Set<string>();

const tell = () => window.endurance?.showChats?.([...shown]);

/** Marks a chat as on screen; the returned function marks it hidden again. */
export function showChat(id: string) {
  shown.add(id);
  tell();
  return () => {
    shown.delete(id);
    tell();
  };
}
