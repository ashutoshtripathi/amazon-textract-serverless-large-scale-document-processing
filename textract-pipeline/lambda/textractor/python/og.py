import json
from helper import FileHelper, S3Helper
from trp import Document
import boto3
from elasticsearch import Elasticsearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth

class OutputGenerator:
    def __init__(self, documentId, response, bucketName, objectName, forms, tables, ddb):
        self.documentId = documentId
        self.response = response
        self.bucketName = bucketName
        self.objectName = objectName
        self.forms = forms
        self.tables = tables
        self.ddb = ddb

        self.outputPath = "{}-analysis/{}/".format(objectName, documentId)

        self.document = Document(self.response)

    def indexDocument(self, bucketName, objectName, text):

        # Update host with endpoint of your Elasticsearch cluster
        #host = "search--xxxxxxxxxxxxxx.us-east-1.es.amazonaws.com
        host = "search-search-e4gpteganu5jmvurcd7xymc4hi.us-east-1.es.amazonaws.com"
        region = 'us-east-1'

        if(text):
            service = 'es'
            ss = boto3.Session()
            credentials = ss.get_credentials()
            region = ss.region_name

            awsauth = AWS4Auth(credentials.access_key, credentials.secret_key, region, service, session_token=credentials.token)

            es = Elasticsearch(
                hosts = [{'host': host, 'port': 443}],
                http_auth = awsauth,
                use_ssl = True,
                verify_certs = True,
                connection_class = RequestsHttpConnection
            )

            document = {
                "name": "{}".format(objectName),
                "bucket" : "{}".format(bucketName),
                "content" : text,
                "claimid" : "foo",
                "date" : "12/12/2019"
            }

            es.index(index="textract", doc_type="document", id=objectName, body=document)

            print("Indexed document")

    def saveItem(self, pk, sk, output):

        jsonItem = {}
        jsonItem['documentId'] = pk
        jsonItem['outputType'] = sk
        jsonItem['outputPath'] = output

        self.ddb.put_item(Item=jsonItem)

    def _outputText(self, page, p):
        text = page.text
        opath = "{}page-{}-text.txt".format(self.outputPath, p)
        S3Helper.writeToS3(text, self.bucketName, opath)
        self.saveItem(self.documentId, "page-{}-Text".format(p), opath)
        print("elastic opath")
        print(opath)
        self.indexDocument(self.bucketName, opath, text)

       # textInReadingOrder = page.getTextInReadingOrder()
       # opath = "{}page-{}-text-inreadingorder.txt".format(self.outputPath, p)
       # S3Helper.writeToS3(textInReadingOrder, self.bucketName, opath)
       # self.saveItem(self.documentId, "page-{}-TextInReadingOrder".format(p), opath)

    def _outputForm(self, page, p):
        csvData = []
        for field in page.form.fields:
            csvItem  = []
            if(field.key):
                csvItem.append(field.key.text)
            else:
                csvItem.append("")
            if(field.value):
                csvItem.append(field.value.text)
            else:
                csvItem.append("")
            csvData.append(csvItem)
        csvFieldNames = ['Key', 'Value']
        opath = "{}page-{}-forms.csv".format(self.outputPath, p)
        S3Helper.writeCSV(csvFieldNames, csvData, self.bucketName, opath)
        self.saveItem(self.documentId, "page-{}-Forms".format(p), opath)

    def _outputTable(self, page, p):

        csvData = []
        for table in page.tables:
            csvRow = []
            csvRow.append("Table")
            csvData.append(csvRow)
            for row in table.rows:
                csvRow  = []
                for cell in row.cells:
                    csvRow.append(cell.text)
                csvData.append(csvRow)
            csvData.append([])
            csvData.append([])

        opath = "{}page-{}-tables.csv".format(self.outputPath, p)
        S3Helper.writeCSVRaw(csvData, self.bucketName, opath)
        self.saveItem(self.documentId, "page-{}-Tables".format(p), opath)

    def run(self):

        if(not self.document.pages):
            return

        opath = "{}response.json".format(self.outputPath)
        S3Helper.writeToS3(json.dumps(self.response), self.bucketName, opath)
        self.saveItem(self.documentId, 'Response', opath)

        print("Total Pages in Document: {}".format(len(self.document.pages)))

        docText = ""

        p = 1
        for page in self.document.pages:

            opath = "{}page-{}-response.json".format(self.outputPath, p)
            S3Helper.writeToS3(json.dumps(page.blocks), self.bucketName, opath)
            self.saveItem(self.documentId, "page-{}-Response".format(p), opath)

            self._outputText(page, p)

            docText = docText + page.text + "\n"

            if(self.forms):
                self._outputForm(page, p)

            if(self.tables):
                self._outputTable(page, p)

            p = p + 1