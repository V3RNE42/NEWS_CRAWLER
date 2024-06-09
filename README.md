# NodeJS Webcrawler/Newsletter based on Sendgrid and OpenAI APIs

Welcome to the NodeJS Webcrawler Newsletter! This newsletter aims to provide you with the latest updates, tips, and resources related to whatever you want! It's defaulted to Spanish newspapers and international security issues, but you can adapt it to your own needs! :^)

## Table of Contents

- [NodeJS Webcrawler/Newsletter based on Sendgrid and OpenAI APIs](#nodejs-webcrawlernewsletter-based-on-sendgrid-and-openai-apis)
  - [Table of Contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Usage](#usage)
  - [Installation](#installation)
    - [Configuration Guide](#configuration-guide)
    - [Customization Guide](#customization-guide)

## Introduction

This is a NodeJS-based project for daily webcrawling of news sites looking for certain terms, then emailing those results if they're from the last 24 hours.
You can download it and use it as you please.

## Usage

To use this NodeJS webcrawler newsletter, follow these steps:

1. Clone the repository to your local machine.
2. Install the required dependencies by running the following command in your terminal:

    ```
    npm install
    ```

3. Configure the webcrawler by updating the `config.json` file with your desired settings. You can specify the target website, crawling depth, and other parameters. Refer to the [Configuration Guide](#configuration-guide) for more details.

4. Customize the webcrawler behavior by modifying the `terminos.js` file. This file contains the terms that the webcrawler will search for on the target website. Refer to the [Customization Guide](#customization-guide) for more details.

5. Run the webcrawler by executing the following command:

    ```
    node main.js
    ```

    This will start the webcrawler and it will begin crawling the target website based on the provided configuration.

6. Monitor the webcrawler's progress and results. The webcrawler will output the crawled data to the console and also save it to a file for further analysis.

## Installation

To install and run this NodeJS webcrawler newsletter, please follow these steps:

1. Install NodeJS on your local machine if you didn't already.

2. Clone the repository to your local machine.

3. Navigate to the project directory in your terminal.

4. Copy the content of `install.txt` file and execute it on Command Prompt.

5. Once the installation is complete, you can proceed to the usage section to configure and run the webcrawler.

### Configuration Guide

The `config.json` file allows you to customize the behavior of the webcrawler. Here are some key settings you can modify:

- `sender`: Specify the email of the sender with an associated smtp.sendgrid account
- `recipients`: Specify the email of the people receiving your emails.
- `crawl`: Set the hour at which the crawling should start.
- `email`: Set the hour from which the emails can be sent - obviously won't start until that hour is reached AND the news-crawling has finished
- `api_key`: Set your current OpenAI API key to use the GPT-4 model for generating some email summaries.
- `smtp_pass`: Set the SendGrid API key of your account

### Customization Guide

The `terminos.js` file contains the terms that the webcrawler will search for on the target websites. You can customize this file by adding or removing **terms** based on your specific requirements. Same applies for **websites**.
