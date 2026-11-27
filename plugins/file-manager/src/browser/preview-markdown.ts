import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true });

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
	tokens[index].attrSet('target', '_blank');
	tokens[index].attrSet('rel', 'noopener noreferrer');
	return renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export function renderMarkdown(source: string) {
	return markdown.render(source);
}
