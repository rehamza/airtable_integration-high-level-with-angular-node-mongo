import { AirtableRevisionParserService } from './airtable-revision-parser.service';

describe('AirtableRevisionParserService', () => {
  let service: AirtableRevisionParserService;

  beforeEach(() => {
    service = new AirtableRevisionParserService();
  });

  it('extracts only status and assignee changes from revision-history HTML', () => {
    const html = `
      <section>
        <article data-activity-id="1">
          <div data-user-id="usrStatus" data-user-name="Sarah QA"></div>
          <time datetime="2026-04-08T09:00:00.000Z"></time>
          <p>Sarah QA changed Status from "Todo" to "In Progress"</p>
        </article>
        <article data-activity-id="2">
          <div data-user-id="usrAssignee" data-user-name="Ali Ops"></div>
          <time datetime="2026-04-08T10:00:00.000Z"></time>
          <p>Ali Ops changed Assignee from Empty to John Smith</p>
        </article>
        <article data-activity-id="3">
          <time datetime="2026-04-08T11:00:00.000Z"></time>
          <p>Someone commented: Please review this task.</p>
        </article>
      </section>
    `;

    const result = service.parseRevisionHistory({
      html,
      sourceUrl: 'https://airtable.example/revision-history',
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(
      expect.objectContaining({
        changeType: 'status',
        fieldName: 'Status',
        oldValue: 'Todo',
        newValue: 'In Progress',
        changedBy: expect.objectContaining({
          userId: 'usrStatus',
          name: 'Sarah QA',
        }),
      }),
    );
    expect(result[1]).toEqual(
      expect.objectContaining({
        changeType: 'assignee',
        fieldName: 'Assignee',
        oldValue: null,
        newValue: 'John Smith',
        changedBy: expect.objectContaining({
          userId: 'usrAssignee',
          name: 'Ali Ops',
        }),
      }),
    );
  });
});
