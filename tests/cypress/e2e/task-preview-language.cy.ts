import {resolvePreviewLanguage} from '../../../src/client/components/taskPreview.shared';

// The second spec in this suite that talks to nothing (see task-duration.cy.ts for the reasoning:
// one test toolchain, no browser, no Jahia, no site). The board's preview-language chain is a pure
// function of three strings, and it decides which TRANSLATION of the reviewed content jContent's
// side panel opens on -- getting it wrong shows a reviewer a version of the page nobody asked them
// to approve, which is a mistake no rendering assertion would catch.
//
// The description fixtures below are real values, copied from jnt:workflowTask nodes on a live
// 8.2.3 (2026-08-16) -- that shape is the whole reason the workflow's language is knowable at all.

// One-step publication summaries as the engine writes them, in three languages.
const FR_SUMMARY = 'fr - One step publication started by root on 8/15/26 - 2 content items involved';
const EN_SUMMARY = 'en - One step publication started by root on 8/15/26 - 3 content items involved';
const ES_SUMMARY = 'es - One step publication started by root on 8/15/26 - 20 content items involved';

const WORKFLOW = 'jnt:workflowTask';
const PLAIN = 'jnt:task';

// What GqlTaskBoard#getTargetNode returns: a render URL whose language segment follows the
// workspace, built server-side through a session that has a locale.
const EN_URL = '/cms/render/default/en/sites/luxe/home/sell.html';

describe('Preview language resolution (pure board logic, no Jahia involved)', () => {
    describe('the workflow task\'s own language', () => {
        it('reads it off the summary the engine stored on the task', () => {
            expect(resolvePreviewLanguage({taskType: WORKFLOW, description: FR_SUMMARY, url: EN_URL}, 'en')).to.equal('fr');
            expect(resolvePreviewLanguage({taskType: WORKFLOW, description: ES_SUMMARY, url: EN_URL}, 'en')).to.equal('es');
            expect(resolvePreviewLanguage({taskType: WORKFLOW, description: EN_SUMMARY, url: EN_URL}, 'fr')).to.equal('en');
        });

        it('wins over both fallbacks: it is the language the review was raised FOR', () => {
            // The URL says English (it was built in the viewer's locale) and so does the viewer --
            // and the request is still about the French translation.
            expect(resolvePreviewLanguage({taskType: WORKFLOW, description: FR_SUMMARY, url: EN_URL}, 'en-US')).to.equal('fr');
        });

        it('is never guessed from a plain task\'s free-text description', () => {
            // A user-written to-do that happens to start the same way. jnt:task has no workflow and
            // therefore no language of its own, so the URL's answer stands.
            expect(resolvePreviewLanguage({taskType: PLAIN, description: FR_SUMMARY, url: EN_URL}, 'de')).to.equal('en');
            expect(resolvePreviewLanguage({taskType: PLAIN, description: 'ok - ship it', url: EN_URL}, 'de')).to.equal('en');
        });

        it('falls through when the task carries no summary at all', () => {
            // Real case, not hypothetical: a workflow started through the GraphQL API (which is how
            // this suite's own fixtures raise one) leaves the description unset.
            expect(resolvePreviewLanguage({taskType: WORKFLOW, description: null, url: EN_URL}, 'de')).to.equal('en');
        });

        it('ignores a description that does not open with a language code', () => {
            [
                'One step publication started by root',
                'FR - One step publication',
                'french - One step publication',
                ' fr - One step publication'
            ].forEach(description => {
                expect(resolvePreviewLanguage({taskType: WORKFLOW, description, url: EN_URL}, 'de'))
                    .to.equal('en', description);
            });
        });
    });

    describe('the target URL', () => {
        it('reads the language segment of any of the three render prefixes', () => {
            const cases: Array<[string, string]> = [
                ['/cms/render/default/fr/sites/luxe/home.html', 'fr'],
                ['/cms/edit/default/de/sites/luxe/home.html', 'de'],
                ['/cms/frame/default/es/sites/luxe/home.html', 'es'],
                ['/cms/render/live/en/sites/luxe/home.html', 'en']
            ];
            cases.forEach(([url, expected]) => {
                expect(resolvePreviewLanguage({taskType: PLAIN, description: null, url}, 'it')).to.equal(expected, url);
            });
        });

        it('gives way to the viewer\'s locale for anything that is not a render URL', () => {
            ['/luxe/home.html', 'https://example.com/page', ''].forEach(url => {
                expect(resolvePreviewLanguage({taskType: PLAIN, description: null, url}, 'de')).to.equal('de', url);
            });
        });
    });

    describe('the viewer\'s locale, as a last resort', () => {
        it('is reduced to the bare language code Jahia stores translations under', () => {
            expect(resolvePreviewLanguage({taskType: PLAIN, description: null, url: ''}, 'fr-FR')).to.equal('fr');
            expect(resolvePreviewLanguage({taskType: PLAIN, description: null, url: ''}, 'fr_FR')).to.equal('fr');
            expect(resolvePreviewLanguage({taskType: PLAIN, description: null, url: ''}, 'fr')).to.equal('fr');
        });
    });
});
