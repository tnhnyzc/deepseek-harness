/**
 * Thin renderer entry. Stage 1 renders the shell's startup state with no
 * Node and no network; stage 4 starts the existing DSH client application
 * tree from this same single root using the same client packages as the
 * browser Web UI.
 * @module @deepseek-ai/dsh-desktop/src/renderer/main
 */
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('desktop renderer: missing #root')
root.dataset.state = 'booting-desktop'
