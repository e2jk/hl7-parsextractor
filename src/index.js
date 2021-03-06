const {ipcRenderer} = require('electron')
const fs = require('fs');
const readline = require('readline');
const stream = require('stream');
// The HL7 Dictionary will be loaded further down, to not block the showing of the UI
var HL7Dictionary;

const selectFileSection = document.getElementById('selectFileSection');
const selectFieldsSection = document.getElementById('selectFieldsSection');
const extractSection = document.getElementById('extractSection');

const selectFileBtn = document.getElementById('selectFileBtn');
const selectNewFileLink = document.getElementById('selectNewFileLink');
const fileSummary = document.getElementById('fileSummary');
const fileSummaryPleaseSelect = document.getElementById('fileSummaryPleaseSelect');
const fieldSelection = document.getElementById('fieldSelection');
const selectionSummary = document.getElementById('selectionSummary');
const changeFieldSelectionSection = document.getElementById('changeFieldSelectionSection');
const changeFieldSelectionLink = document.getElementById('changeFieldSelectionLink');
const extractBtn = document.getElementById('extractBtn');

var rl;
var fileContentArray = {};
var segmentsArray = {};
var selectedFieldsArray = {};
var selectedFieldsMetadataArray = {};
var selectedFieldsSortedArray = {};
var nonEmptyFieldsArray = {};
var numMessages = 0;
var numSegments = 0;
var readStartTime = 0;
var readEndTime = 0;
var writeStartTime = 0;
var writeEndTime = 0;

// Set defaults, actual values will be read from each message's MSH segment
var fieldSep   = '|';
var compSep    = '^';
var subCompSep = '&';
var escapeChar = '\\';
var repeatSep  = '~';

selectFileBtn.addEventListener('click', selectFile);
selectNewFileLink.addEventListener('click', selectFile);

function selectFile(event) {
  console.log("Opening file via click on", event.srcElement.id);
  ipcRenderer.send('open-file-dialog')
  // This is where we "hide" loading the HL7 Dictionary, since it takes some time to load
  loadHL7Dictionary();
}



changeFieldSelectionLink.addEventListener('click', (event) => {
  console.log("Click on changeFieldSelectionLink");
  // Show the field selection section
  fieldSelection.style.display = 'block';
  fileSummaryPleaseSelect.style.display = 'inline';
  // Hide the selection summary section
  selectionSummary.style.display = 'none';
  changeFieldSelectionSection.style.display = 'none';
})

extractBtn.addEventListener('click', (event) => {
  console.log("Click on extractBtn");
  selectedFieldsArray = new Array();
  selectedFieldsMetadataArray = new Array();
  selectedFieldsSortedArray = new Array();
  var segType = "";
  var fieldID = "";
  // CSS selector for all inputs of type checkbox that are checked and have the class fieldCheckbox
  document.querySelectorAll('input[type="checkbox"]:checked.fieldCheckbox').forEach(function(fieldCheckbox) {
    // Three arrays: first one is a plain array with the list of selected fields
    selectedFieldsArray.push(fieldCheckbox.id.substring(6,20));
    // The second has 2 levels, first per segment type then fields (used when extracting, as processing is per segment)
    segType = fieldCheckbox.id.substring(6,9);
    fieldID = fieldCheckbox.id.substring(10,20);
    if (!selectedFieldsSortedArray.hasOwnProperty(segType)) {
      selectedFieldsSortedArray[segType] = new Array();
    }
    selectedFieldsSortedArray[segType].push(fieldID);
    // The third array contains the metadata (data type, name, etc.) for each selected field
    selectedFieldsMetadataArray[fieldCheckbox.id.substring(6,20)] = new Array();
    if (HL7Dictionary.segments.hasOwnProperty(segType)) {
      if (HL7Dictionary.segments[segType]["fields"].hasOwnProperty(fieldID - 1)) {
        selectedFieldsMetadataArray[fieldCheckbox.id.substring(6,20)] = HL7Dictionary.segments[segType]["fields"][fieldID - 1];
      }
    }
  });
  // Display the selection summary section
  selectionSummary.style.display = 'block';
  changeFieldSelectionSection.style.display = 'block';
  // Hide the field selection section
  fieldSelection.style.display = 'none';
  fileSummaryPleaseSelect.style.display = 'none';
  if (selectedFieldsArray.length > 0){
    // Text for the selection summary section
    selectionSummary.innerHTML = "Extracting the following fields:\n<ul>\n  <li>" + selectedFieldsArray.join("</li>\n  <li>") + "</li>\n</ul>";
    // Send signal to main renderer to show the Save dialog
    ipcRenderer.send('save-dialog');
  } else {
    // Show error message in selection summary section
    selectionSummary.innerHTML = "Please select at least one field to extract.";
  }
})

function HL7MessageToCSVline(CSVContentArray) {
  var CSVContent = "";
  for (var i = 0; i < CSVContentArray.length; i++) {
    CSVContent += (i > 0 ? ";" : "")
    if (CSVContentArray[i] != undefined) {
      // If the value contains a quote, surround the value with double quotes
      surroundWithQuotes = CSVContentArray[i].includes('"') ? '"' : "";
      CSVContent += surroundWithQuotes + CSVContentArray[i] + surroundWithQuotes;
    }
  }
  CSVContent += "\n";
  return CSVContent;
}

ipcRenderer.on('saved-file', (event, path) => {
  if (!path) {
    // Not doing anything if Cancel was pressed, maybe user wants to change the selected fields?
  } else {
    // Generating content to be saved in CSV file
    var fieldsInThisMessageArray;
    var segmentPositionInCSVArray = new Array();
    var fieldPositionInCSVArray = new Array();
    var fieldValue;
    var fieldMetadata;
    var dateDelimiter = ["", "/", "/", " ", ":" , ":"];
    var dateOutput;
    var dateTimeRegexp = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?$/;
    var regexMatch;
    var CSVHeader = "";
    var CSVContent = "";
    var CSVContentArray;
    var surroundWithQuotes = "";
    var multSeg;
    writeStartTime = Date.now();
    for (var seg in fileContentArray) {
      if (fileContentArray.hasOwnProperty(seg)) {
        fields = fileContentArray[seg];
        // New message, i.e. new line in CSV file
        if ("MSH" == fields[0]) {
          // First save of the previous message's content, if any
          if (CSVContentArray != undefined) {
            CSVContent += HL7MessageToCSVline(CSVContentArray);
          }
          // Then reinitialize the arrays to process the new message
          CSVContentArray = new Array();
          fieldsInThisMessageArray = new Array();
        }
        // Only process segments that have fields to be exported in the CSV file
        if (selectedFieldsSortedArray.hasOwnProperty(fields[0])) {
          // Keep track how many of this segment type are in this message (handle up to 1000 multiple segments)
          multSeg = 0;
          for (var i = 0; i < 1000; i++) {
            if (!fieldsInThisMessageArray.hasOwnProperty(fields[0] + "_" + i)) {
              multSeg = i;
              fieldsInThisMessageArray[fields[0] + "_" + multSeg] = "";
              break;
            }
          }
          // Check which position in the CSV file is reserved for this iteration of that segment
          if (!segmentPositionInCSVArray.hasOwnProperty(fields[0] + "_" + multSeg)){
            segmentPositionInCSVArray[fields[0] + "_" + multSeg] = Object.keys(segmentPositionInCSVArray).length;
            for (var field in selectedFieldsSortedArray[fields[0]]) {
              if (selectedFieldsSortedArray[fields[0]].hasOwnProperty(field)) {
                fieldPositionInCSVArray[fields[0] + "-" + selectedFieldsSortedArray[fields[0]][field] + "_" + multSeg] = Object.keys(fieldPositionInCSVArray).length;
              }
            }
          }
          // Keeping the value in the array that will be written to the CSV file
          for (var field in selectedFieldsSortedArray[fields[0]]) {
            if (selectedFieldsSortedArray[fields[0]].hasOwnProperty(field)) {
              fieldValue = fields[selectedFieldsSortedArray[fields[0]][field]];
              fieldMetadata = selectedFieldsMetadataArray[fields[0] + "-" + selectedFieldsSortedArray[fields[0]][field]];

              // When a field is date/time, try to make it Excel-friendly
              if (fieldMetadata.datatype == "DTM") {
                regexMatch = dateTimeRegexp.exec(fieldValue);
                if (regexMatch) {
                  dateOutput = "";
                  for (var i = 1; i < regexMatch.length; i++) {
                    if (undefined === regexMatch[i]) {
                      continue;
                    }
                    dateOutput += dateDelimiter[i-1] + regexMatch[i];
                  }
                  if ("" !== dateOutput) {
                    fieldValue = dateOutput;
                  }
                }
              }

              CSVContentArray[fieldPositionInCSVArray[fields[0] + "-" + selectedFieldsSortedArray[fields[0]][field] + "_" + multSeg]] = fieldValue;
            }
          }
        }
      }
    }

    // Don't forget the very last message!
    CSVContent += HL7MessageToCSVline(CSVContentArray);

    // Add CSV header to content to be saved
    CSVContentArray = new Array();
    for (var fieldRepetition in fieldPositionInCSVArray) {
      if (fieldPositionInCSVArray.hasOwnProperty(fieldRepetition)) {
        CSVContentArray[fieldPositionInCSVArray[fieldRepetition]] = fieldRepetition;
      }
    }
    var headerParts;
    var segmentParts;
    for (var i = 0; i < CSVContentArray.length; i++) {
      CSVHeader += (i > 0 ? ";" : "");
      if (CSVContentArray.hasOwnProperty(i)) {
        headerParts = CSVContentArray[i].split("_");
        CSVHeader += headerParts[0];
        if (headerParts[1] > 0){
          CSVHeader += " (rep. #" + (parseInt(headerParts[1], 10) + 1) + ")"
        }
        segmentParts = headerParts[0].split("-");
        if (HL7Dictionary.segments.hasOwnProperty(segmentParts[0])) {
          if (HL7Dictionary.segments[segmentParts[0]]["fields"].hasOwnProperty(segmentParts[1] - 1)) {
            CSVHeader += ' - ' + HL7Dictionary.segments[segmentParts[0]]["fields"][segmentParts[1] - 1].desc;
          }
        }
      }
    }
    CSVContent = CSVHeader + "\n" + CSVContent;

    // Saving CSV file
    fs.writeFile(path, CSVContent, (err) => {
      if (err) throw err;
      console.log(`The file has been saved: ${path}`);
      writeEndTime = Date.now();
      var elapsedTime = writeEndTime - writeStartTime;
      console.log("Done writing CSV file in", elapsedTime, "msec");
    });
  }
})

ipcRenderer.on('selected-file', (event, file) => {
  fileContentArray = new Array();
  segmentsArray = {};
  numMessages = 0;
  numSegments = 0;

  // Normally the HL7 Dictionary has already been loaded when clicking on selectFileBtn
  // But in case of debug mode, we jump right into here, hence "double" loading
  loadHL7Dictionary();

  console.log("Opening file: " + file);

  // Stream file instead of opening at once asynchronously, via https://coderwall.com/p/ohjerg/read-large-text-files-in-nodejs
  var instream = fs.createReadStream(file);
  var outstream = new stream;
  rl = readline.createInterface(instream, outstream);

  readStartTime = Date.now();

  rl.on('line', function(line) {
    analyzeSegment(line);
  });

  rl.on('close', function() {
    fileAnalyzed();
  });
})

function analyzeSegment(line) {
  numSegments++;
  if ("MSH" ==  line.substring(0,3)){
    numMessages++;
    determineEncChars(line.substring(0,8));
  }
  // Split segment in its fields
  var currSegFields = line.split(fieldSep);
  // Remove last item if the segments ends with the field separator
  if (currSegFields[(currSegFields.length - 1)] == '') currSegFields.splice(-1,1);
  // Correct field numbering for MSH segment
  if ("MSH" ==  line.substring(0,3)) {
    currSegFields[0] = fieldSep; // Replace the array's first value "MSH" with the Field Separator
    currSegFields.unshift("MSH");  // Add back "MSH" as the array's first value
  }
  // Store for use when extracting
  fileContentArray.push(currSegFields);
  // Segment identifier
  var segType = currSegFields[0];

  // Determine the maximum number of fields in a segment
  if (!segmentsArray[segType]) {
    segmentsArray[segType] = (currSegFields.length - 1);
  }
  if (segmentsArray[segType] < (currSegFields.length - 1)) {
    segmentsArray[segType] = (currSegFields.length - 1);
  }

  // Build a list of only the segments that have a value (active null "" is considered as having a value)
  // This in order to hide the fields that are not populated in any message
  for (var i = 1; i < currSegFields.length; i++) {
    if ("" !== currSegFields[i]) {
      nonEmptyFieldsArray[segType + "-" + i] = "";
    }
  }
}

// Determine the Encoding Characters from the MSH segment
function determineEncChars(encChars) {
  fieldSep   = encChars.substring(3,4);
  compSep    = encChars.substring(4,5);
  repeatSep  = encChars.substring(5,6);
  escapeChar = encChars.substring(6,7);
  subCompSep = encChars.substring(7,8);
}

function fileAnalyzed() {
  readEndTime = Date.now();
  var elapsedTime = readEndTime - readStartTime;
  console.log("Done analyzing file in", elapsedTime, "msec");
  fileSummary.innerHTML = "This file contains <strong>" + numMessages + " messages</strong> and <strong>" + numSegments + " segments</strong>.";
  fileSummaryPleaseSelect.style.display = 'inline';

  var fieldSelectionHTML = "";
  var tempFieldSelectionHTML = "";
  var segmentDescription = "";
  var fieldDescription = "";
  var numFields = 0;
  var numPopulatedFieldsInSegment = 0;
  for (var seg in segmentsArray) {
    numPopulatedFieldsInSegment = 0;
    tempFieldSelectionHTML = "";
    segmentDescription = (HL7Dictionary.segments.hasOwnProperty(seg)) ? ' - ' + HL7Dictionary.segments[seg].desc : "";
    for (var i = 0; i < segmentsArray[seg]; i++) {
      // Only show fields that are populated in at least one message
      if (undefined !== nonEmptyFieldsArray[seg + '-' + (i+1)]) {
        numPopulatedFieldsInSegment++;
        fieldDescription = "";
        if (HL7Dictionary.segments.hasOwnProperty(seg)) {
          if (HL7Dictionary.segments[seg]["fields"].hasOwnProperty(i)) {
            fieldDescription = ' - ' + HL7Dictionary.segments[seg]["fields"][i].desc;
          }
        }
        tempFieldSelectionHTML += '    <input type="checkbox" id="field_' + seg + '-' + (i+1) + '" class="fieldCheckbox"><label for="field_' + seg + '-' + (i+1) + '">' + seg + '-' + (i+1) + fieldDescription + '</label><br>\n';
      }
    }
    // Only add this segment if there was at least one field populated
    if (numPopulatedFieldsInSegment > 0) {
      fieldSelectionHTML += '<li class="segmentSelect">\n  <div class="segment">' + seg + segmentDescription + ' (' + numPopulatedFieldsInSegment + '/' + segmentsArray[seg] + ' fields populated)</div>\n  <div class="fieldSelect">\n' + tempFieldSelectionHTML + '  </div>\n</li>\n';
    }
  }
  fieldSelection.innerHTML = fieldSelectionHTML;

  // Hide the file selection section and show the field selection section
  selectFieldsSection.style.display = 'block';
  extractSection.style.display = 'block';
  fieldSelection.style.display = 'block';
  fileSummaryPleaseSelect.style.display = 'inline';
  selectionSummary.style.display = 'none';
  selectFileSection.style.display = 'none';
  changeFieldSelectionSection.style.display = 'none';
}


function loadHL7Dictionary() {
  var loadHL7StartTime = Date.now();
  // Specifically load version 2.7.1
  HL7Dictionary = require('hl7-dictionary/lib/2.7.1');
  var loadHL7EndTime = Date.now();
  var elapsedLoadHL7Time = loadHL7EndTime - loadHL7StartTime;
  console.log("elapsedLoadHL7Time:",elapsedLoadHL7Time,"ms");
}
