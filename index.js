// Import required packages and modules.
import noble from "@abandonware/noble"; // For Bluetooth device scanning and connection.
import spinner from "cli-spinner"; // For displaying a spinner in the CLI.
import { Command } from "commander"; // For parsing command line arguments.
import { createReadStream, createWriteStream } from "fs"; // For file I/O.
import * as path from "path"; // For path-related operations.
import { select, confirm } from "@inquirer/prompts"; // For interactive CLI prompts.
import Jimp from "jimp"; // For image processing.
import { PNG } from "pngjs"; // For PNG parsing and manipulation.

// Use your user‑defined dithering library.
import { dither, ALGORITHMS } from "./dithering.js";

const { Spinner } = spinner;

// The number of bytes per line that the printer expects.
// Adjust this value to match the specific printer output width.
const BYTES_PER_LINE = 70;
// The image width in pixels matching the printer characteristic.
// Each byte stands for 8 pixels, so we multiply.
const IMAGE_WIDTH = BYTES_PER_LINE * 8;

// Special keys for device selection menu.
const SCAN_AGAIN_SELECTION = "__scan_again__";
const QUIT_SELECTION = "__quit__";

// Object to hold discovered Bluetooth devices.
let discoveredDevices = {};

// -------------------------
// Command line interface setup
// -------------------------

// Set up command line options using Commander.
const program = new Command();
program
  .option("-f, --file <path>", "path for image to print", "./burger.png")
  .option(
    "-s, --scale <size>",
    "percent scale at which the image should print (1-100)",
    100
  );
program.parse(process.argv);
const { file, scale } = program.opts();

// Create a selection prompt using keys from ALGORITHMS.
const algorithmChoice = await select({
  message: "Select dithering algorithm:",
  choices: Object.keys(ALGORITHMS).map(key => ({
    // The key is used as both the display and value.
    value: key
  })),
  default: "FLOYD_STEINBERG",
  pageSize: Object.keys(ALGORITHMS).length
});

// Now that algorithmChoice is defined, pass it in:
const printableImgPath = await makeDitheredImage(file, scale, algorithmChoice);
const characteristic = await getDeviceCharacteristicMenu(printableImgPath);

// ----- NEW: Ask user whether to adjust printer density -----
const adjustDensity = await confirm({ 
  message: "Would you like to adjust printer density (black intensity)?" 
});
if (adjustDensity) {
  // Prompt the user to select a density level.
  // Soft, Medium, and Strong correspond to different density bytes.
  const densityLevel = await select({
    message: "Select desired density level:",
    choices: [
      { name: "Soft", value: 0x40 },
      { name: "Medium", value: 0x80 },
      { name: "Strong", value: 0xff }
    ],
    pageSize: 3,
  });
  await sendDensityControlPacket(characteristic, densityLevel);
}
// ---------------------------------------------------------

const data = await getPrintDataFromPort(printableImgPath);
characteristic.write(Buffer.from(data), true);

// -------------------------
// Helper Functions
// -------------------------

// Returns a promise that resolves after a given number of ms.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// This function scans for nearby Bluetooth devices and presents
// an interactive menu to select a valid Bluetooth printer.
// It keeps scanning until a writable device is found or the user quits.
async function getDeviceCharacteristicMenu(printableImgPath) {
  let scanDurationInMs = 5000;
  do {
    await scanDevices(scanDurationInMs);
    const choice = await selectDevice();

    if (choice === SCAN_AGAIN_SELECTION) {
      // If the user chooses to scan again, increase the scan duration.
      scanDurationInMs = 10000;
      scanDevices();
    } else if (choice == QUIT_SELECTION) {
      // Exit the process if the user opts to quit.
      process.exit();
    } else {
      // Retrieve the selected peripheral device.
      let peripheral = discoveredDevices[choice];
      // Attempt to get a characteristic that we can write to.
      const characteristic = await getWritableCharacteristic(peripheral);

      if (!characteristic) {
        // If unable to write to the chosen device, ask if the user wants to try again.
        const tryAgain = await promptTryAgain();
        if (tryAgain) {
          continue;
        } else {
          process.exit();
        }
      } else {
        // Return the writable characteristic if available.
        return characteristic;
      }
    }
  } while (true);
}

// Scans for Bluetooth devices for a specified duration.
// Discovered devices with a valid localName are stored in discoveredDevices.
async function scanDevices(scanDurationInMs = 5000) {
  discoveredDevices = {};

  const spinner = new Spinner("scanning bluetooth devices.. %s");
  spinner.setSpinnerString("|/-\\");
  spinner.start();
  noble.on("discover", async (peripheral) => {
    const { localName } = peripheral.advertisement;
    if (localName === undefined || localName.trim().length === 0) {
      // Skip peripherals with invalid names.
      return;
    }
    discoveredDevices[localName] = peripheral;
  });
  noble.startScanningAsync();

  // Wait for the specified scanning duration.
  await delay(scanDurationInMs);

  // Stop scanning and clear the spinner.
  await noble.stopScanningAsync();
  spinner.stop(true);
}

// Presents an interactive CLI menu listing all discovered devices,
// along with options to scan again or quit.
async function selectDevice() {
  const choices = [];
  for (const key in discoveredDevices) {
    choices.push({
      value: key,
    });
  }
  choices.push({
    name: "- Scan again",
    value: SCAN_AGAIN_SELECTION,
  });

  choices.push({
    name: "- Quit",
    value: QUIT_SELECTION,
  });

  const prompt = {
    message: "Select your bluetooth printer",
    choices,
    pageSize: 12,
  };
  return select(prompt);
}

// Connects to a peripheral and discovers all its services and characteristics.
// Returns a characteristic that supports 'write' if available.
async function getWritableCharacteristic(peripheral) {
  await peripheral.connectAsync();
  const { characteristics } =
    await peripheral.discoverAllServicesAndCharacteristicsAsync();
  // Filter characteristics to find one that supports writing.
  const [characteristic] = characteristics.filter((characteristic) => {
    return characteristic.properties.includes("write");
  });
  return characteristic;
}

// Inform the user about an unsupported device and ask whether to try again.
async function promptTryAgain() {
  console.log("dang it doesn't look like we can print to this device 😕");
  return confirm({ message: "want to try again?" });
}

// This function reads the dithered image, converts it into printer commands,
// and returns an array of bytes that represent the complete print data.
async function getPrintDataFromPort(printableImgPath) {
  const pic = await Jimp.read(printableImgPath);
  let remaining = pic.bitmap.height;
  let printData = [];
  let index = 0;

  // ----- PRINTING HEADER -----
  // Following sequences are based on the printer's command protocol.

  // Initialize printer.
  printData[index++] = 27;
  printData[index++] = 64;

  // Select justification command.
  printData[index++] = 27;
  printData[index++] = 97;

  // Justify left (0=left, 1=center, 2=right).
  printData[index++] = 0;

  // End of header codes.
  printData[index++] = 31;
  printData[index++] = 17;
  printData[index++] = 2;
  printData[index++] = 4;
  // -----------------------------

  let line = 0;

  // Loop through each group of lines based on how many rows remain.
  while (remaining > 0) {
    let lines = remaining;
    if (lines > 256) {
      lines = 256; // Limit block height to 256 lines due to protocol constraints.
    }

    // ----- PRINTING MARKER -----
    // Command for printing a raster bit image block.
    printData[index++] = 29;
    printData[index++] = 118;
    printData[index++] = 48;

    // Mode for raster image printing.
    // Mode: 0=normal, 1=double width, 2=double height, 3=quadruple.
    printData[index++] = 0;

    // Write the number of bytes per line.
    printData[index++] = BYTES_PER_LINE;
    printData[index++] = 0;

    // Number of lines to print in this block (minus one).
    printData[index++] = lines - 1;
    printData[index++] = 0;
    // -----------------------------

    remaining -= lines;

    // Process each line.
    while (lines > 0) {
      // Process each byte of the current line.
      for (let x = 0; x < BYTES_PER_LINE; x++) {
        let byte = 0;

        // Each byte represents 8 pixels; loop through each bit.
        for (let bit = 0; bit < 8; bit++) {
          const rgba = Jimp.intToRGBA(pic.getPixelColor(x * 8 + bit, line));
          // If the pixel is black and not transparent, set corresponding bit.
          if (rgba.r === 0 && rgba.a !== 0) {
            byte |= 1 << (7 - bit);
          }
        }
        // Special handling: if byte value equals newline, change it.
        if (byte === 0x0a) {
          byte = 0x14;
        }
        printData[index++] = byte;
      }
      lines--;
      line++;
    }
  }

  // ----- PRINTING FOOTER -----
  // Commands to feed some empty lines after the image.
  printData[index++] = 27;
  printData[index++] = 100;
  printData[index++] = 2;

  printData[index++] = 27;
  printData[index++] = 100;
  printData[index++] = 2;

  // Additional footer printer commands.
  printData[index++] = 31;
  printData[index++] = 17;
  printData[index++] = 8;

  printData[index++] = 31;
  printData[index++] = 17;
  printData[index++] = 14;

  printData[index++] = 31;
  printData[index++] = 17;
  printData[index++] = 7;

  printData[index++] = 31;
  printData[index++] = 17;
  printData[index++] = 9;
  // -----------------------------

  return printData;
}

// This function processes the image file to match the printer's requirements.
// It performs several steps: resizing, compositing with a transparent background,
// and finally dithering.
async function makeDitheredImage(imgPath, scale, algorithmChoice) {
  let originalFileName = path.basename(imgPath);
  if (!originalFileName) {
    throw new Error("Invalid file name");
  }
  let pic = await Jimp.read(imgPath);
  const scalePercentage = Math.max(scale / 100.0, 0.01);
  const scaledWidth = Math.floor(scalePercentage * IMAGE_WIDTH);

  // Resize the image based on scale percentage.
  const resizedImgPath = `${imgPath}--resized.png`;
  pic = pic.resize(scaledWidth, Jimp.AUTO);

  // Read the transparent background image to fill in space.
  let transparentBackground = await Jimp.read("./transparent-square.png");
  transparentBackground = transparentBackground.resize(
    IMAGE_WIDTH,
    pic.bitmap.height
  );
  // Calculate offset to composite the image against the background.
  const x = IMAGE_WIDTH - pic.bitmap.width;
  const composedPic = transparentBackground.composite(pic, x, 0);

  // Write the composite image to file.
  await composedPic.writeAsync(resizedImgPath);

  // Convert the composed image to a dithered black & white image.
  // TODO: Consider swapping the dithering library for improved quality.
  return convertToDithered(resizedImgPath, algorithmChoice);
}

// This function performs image dithering using the Floyd-Steinberg algorithm.
// It converts a resized image into a dithered image suitable for the printer.
async function convertToDithered(resizedImgPath, algorithmChoice) {
  const ditheredImgPath = `${resizedImgPath}--dithered.png`;
  return new Promise((resolve, reject) => {
    createReadStream(resizedImgPath)
      .pipe(new PNG())
      .on("parsed", function () {
        // 'this' is the PNG image object with width, height, and data properties.
        // Apply the selected dithering algorithm using your library.
        // Lookup the algorithm from ALGORITHMS using the algorithmChoice key.
        dither(this, ALGORITHMS[algorithmChoice]);
        // Pack the modified image data and pipe it to a write stream.
        this.pack()
          .pipe(createWriteStream(ditheredImgPath))
          .on("finish", () => resolve(ditheredImgPath))
          .on("error", reject);
      })
      .on("error", reject);
  });
}

// ----- NEW HELPER FUNCTION -----
async function sendDensityControlPacket(characteristic, density) {
  // Build the packet using a minimal header and command sequence.
  // The density control byte is placed at offset 22.
  const packet = [
    0x02, 0x08, 0x00, 0x1a,
    0x00, 0x16, 0x00, 0x41,
    0x00, 0x0b, 0xff, 0x23,
    0x01, 0x1b, 0x40, 0x1f,
    0x11, 0x02, 0x04, 0x1f,
    0x11, 0x37, density, 0x1f,
    0x11, 0x0b, 0x1f, 0x11,
    0x35, 0x00, 0x86
  ];
  // Write the packet to the printer.
  characteristic.write(Buffer.from(packet), true);
  console.log(`Density control packet sent with density: 0x${density.toString(16)}`);
}
