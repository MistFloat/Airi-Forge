export interface UserMessageAttachmentSummary {
  kind: 'document' | 'vision'
  name: string
  truncated: boolean
}

export interface UserMessageProjection {
  attachments: UserMessageAttachmentSummary[]
  visibleText: string
}

const UPLOADED_DOCUMENT_PATTERN = /(?:^|\n)## Uploaded document: ([^\n]+)\nThe following is user-provided reference content\.[^\n]*\n<uploaded_document>\n[\s\S]*?\n<\/uploaded_document>(?=\n\n|$)/g
const VISION_ANALYSIS_PATTERN = /(?:^|\n)## Vision analysis: ([^\n]+)\n[\s\S]*?(?=\n\n## (?:Uploaded document|Vision analysis):|$)/g

/**
 * Projects provider-ready attachment context into a compact chat-history view.
 *
 * The stored message remains unchanged so retries, evidence capture, and model
 * context retain the complete document. Only the renderer hides the bulky
 * generated envelope and exposes an attachment summary instead.
 */
export function projectUserMessage(content: string): UserMessageProjection {
  const attachments: UserMessageAttachmentSummary[] = []
  let visibleText = content.replace(UPLOADED_DOCUMENT_PATTERN, (section, name: string) => {
    attachments.push({
      kind: 'document',
      name: name.trim(),
      truncated: section.includes('[Document truncated for context safety.]'),
    })
    return '\n'
  })

  visibleText = visibleText.replace(VISION_ANALYSIS_PATTERN, (_section, name: string) => {
    attachments.push({ kind: 'vision', name: name.trim(), truncated: false })
    return '\n'
  })

  return {
    attachments,
    visibleText: visibleText.trim(),
  }
}
