import type { DocPage } from "./docs";

export function DocArticle({ doc }: { doc: DocPage }) {
  return (
    <div className="doc-content-grid">
      <article className="doc-article">
        <header>
          <h1>{doc.title}</h1>
          <p>{doc.description}</p>
        </header>
        <div className="doc-body">{doc.body}</div>
      </article>
      <aside className="doc-toc" aria-label="On this page">
        <span>On this page</span>
        <nav>
          {doc.sections.map((section) => (
            <a href={`#${section.id}`} key={section.id}>
              {section.label}
            </a>
          ))}
        </nav>
      </aside>
    </div>
  );
}
