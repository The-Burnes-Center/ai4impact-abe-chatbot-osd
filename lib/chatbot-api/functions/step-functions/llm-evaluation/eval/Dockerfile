FROM public.ecr.aws/lambda/python:3.12


# Copy function code
COPY lambda_function.py ${LAMBDA_TASK_ROOT}

# Install dependencies
COPY requirements.txt .
RUN pip install -r requirements.txt --target "${LAMBDA_TASK_ROOT}"

# Download nltk data if required for BLEU score
RUN python -m nltk.downloader -d ${LAMBDA_TASK_ROOT}/nltk_data punkt

# Set the CMD to your handler (function name)
CMD ["lambda_function.lambda_handler"]