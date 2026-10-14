from rpa_sdk import rpa

rpa.call('browser.open', {'url': rpa.get('url')})
text = rpa.call('browser.text', {'selector': rpa.get('selector')})
report = rpa.call('file.xlsxWrite', {'path': rpa.get('reportFile'), 'rows': [{'text': text}]})
rpa.output({'text': text, 'report': report})
