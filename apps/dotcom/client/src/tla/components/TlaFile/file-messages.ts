import { defineMessages } from '../../utils/i18n'

export const fileMessages = defineMessages({
	untitled: { defaultMessage: 'File' },
	download: { defaultMessage: 'Download' },
	open: { defaultMessage: 'Open' },
	description: { defaultMessage: 'Description' },
	descriptionPlaceholder: { defaultMessage: 'Add a description for this file…' },
	loading: { defaultMessage: 'Loading…' },
	loadError: { defaultMessage: "Couldn't load this file." },
	notUploaded: { defaultMessage: "This file's contents aren't stored in this browser." },
	unsupported: {
		defaultMessage: "This file type can't be previewed yet. Download it to view the contents.",
	},
	retry: { defaultMessage: 'Try again' },
	preview: { defaultMessage: 'Preview' },
	edit: { defaultMessage: 'Edit' },
	revert: { defaultMessage: 'Revert' },
	downloadEdited: { defaultMessage: 'Download a copy' },
	docxEditWarning: {
		defaultMessage:
			'Edit the document directly. The copy you download keeps text, headings, lists, tables and images — anything else Word stored (footnotes, comments, page layout) is not carried over.',
	},
})
